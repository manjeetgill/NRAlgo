/** Local PostgreSQL bootstrap. Uses a project-owned cluster on loopback port 55432,
 * so it does not modify an existing Homebrew database or require a paid/Docker Desktop service.
 * Private generated connection settings live in ignored .runtime/postgres-access.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

const projectRoot = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url),
);
const runtimeDirectory = resolve(projectRoot, ".runtime");
const configurationPath = resolve(runtimeDirectory, "postgres-access.json");
const clusterDirectory = resolve(runtimeDirectory, "postgres");
interface LocalPostgresConfiguration {
  adminUrl: string;
  applicationUrl: string;
  applicationPassword: string;
  port: number;
}

/** Read the private local connection file without ever logging its passwords. */
export function readLocalPostgresConfiguration(): LocalPostgresConfiguration | null {
  if (!existsSync(configurationPath)) return null;
  const config = JSON.parse(
    readFileSync(configurationPath, "utf8"),
  ) as LocalPostgresConfiguration;
  if (
    !config.adminUrl ||
    !config.applicationUrl ||
    !config.applicationPassword ||
    !Number.isInteger(config.port)
  )
    throw new Error("Invalid local PostgreSQL configuration.");
  return config;
}
/** Resolve installed PostgreSQL tools; PG_BIN can point at another local PostgreSQL installation. */
function postgresBinaryDirectory(): string {
  const directory = [
    process.env.PG_BIN,
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin",
  ].find((path) => path && existsSync(resolve(path, "pg_ctl")));
  if (!directory)
    throw new Error(
      "Install PostgreSQL 17 (macOS: brew install postgresql@17), or set PG_BIN.",
    );
  return directory;
}
/** Run a PostgreSQL utility without shell interpolation. Optional passwords travel via stdin only. */
function runPostgresUtility(name: string, args: string[], input?: string) {
  const result = spawnSync(resolve(postgresBinaryDirectory(), name), args, {
    input,
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `PostgreSQL ${name} failed. Check .runtime/postgres.log and that port 55432 is available.`,
    );
}
/** Start only this project's cluster and create its app database if missing; return private settings.
 * PostgreSQL keeps running after the app exits. Use make db-stop to explicitly stop this cluster.
 */
export async function ensureLocalPostgres(): Promise<LocalPostgresConfiguration> {
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  let config = readLocalPostgresConfiguration();
  if (!config) {
    const adminPassword = randomBytes(32).toString("hex"),
      applicationPassword = randomBytes(32).toString("hex"),
      port = 55432;
    config = {
      adminUrl: `postgresql://nralgo_admin:${adminPassword}@127.0.0.1:${port}/nralgo`,
      applicationUrl: `postgresql://nexus_app:${applicationPassword}@127.0.0.1:${port}/nralgo`,
      applicationPassword,
      port,
    };
    writeFileSync(configurationPath, JSON.stringify(config, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (!existsSync(resolve(clusterDirectory, "PG_VERSION"))) {
    const password = decodeURIComponent(new URL(config.adminUrl).password);
    runPostgresUtility(
      "initdb",
      [
        "-D",
        clusterDirectory,
        "-U",
        "nralgo_admin",
        "--encoding=UTF8",
        "--no-locale",
        "--auth-local=scram-sha-256",
        "--auth-host=scram-sha-256",
        "--pwfile=/dev/stdin",
      ],
      `${password}\n`,
    );
  }
  const status = spawnSync(
    resolve(postgresBinaryDirectory(), "pg_ctl"),
    ["-D", clusterDirectory, "status"],
    { stdio: "ignore" },
  );
  if (status.status !== 0)
    runPostgresUtility("pg_ctl", [
      "-D",
      clusterDirectory,
      "-l",
      resolve(runtimeDirectory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${config.port} -k ${runtimeDirectory}`,
      "-w",
      "-t",
      "30",
      "start",
    ]);
  const adminUrl = new URL(config.adminUrl);
  adminUrl.pathname = "/postgres";
  const client = new pg.Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    if (
      !(
        await client.query(
          "SELECT datname FROM pg_database WHERE datname='nralgo'",
        )
      ).rows.length
    )
      await client.query("CREATE DATABASE nralgo");
  } finally {
    await client.end();
  }
  return config;
}
/** Stop the known project cluster only; never stop another PostgreSQL service on the machine. */
export function stopLocalPostgres() {
  if (existsSync(resolve(clusterDirectory, "PG_VERSION")))
    runPostgresUtility("pg_ctl", [
      "-D",
      clusterDirectory,
      "-m",
      "fast",
      "-w",
      "stop",
    ]);
}

/** Defer CLI execution until both database modules finish loading. The migration adapter
 * reads local settings from this module, so awaiting its import during evaluation deadlocks.
 */
async function runLocalDatabaseCommand() {
  if (process.argv.includes("--stop")) stopLocalPostgres();
  else {
    const config = await ensureLocalPostgres();
    const { openDatabaseStore, runDatabaseMigrations } =
      await import("./database.js");
    const database = openDatabaseStore(config.adminUrl);
    try {
      await runDatabaseMigrations(database, {
        runtimePassword: config.applicationPassword,
      });
    } finally {
      await database.close();
    }
    console.log("Local PostgreSQL ready on 127.0.0.1:55432.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  setImmediate(
    () =>
      void runLocalDatabaseCommand().catch((error) => {
        console.error(
          error instanceof Error
            ? error.message
            : "Local PostgreSQL startup failed.",
        );
        process.exitCode = 1;
      }),
  );
}
