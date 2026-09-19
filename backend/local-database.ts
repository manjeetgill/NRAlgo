/** Local PostgreSQL bootstrap. Uses a project-owned cluster on loopback port 55432,
 * so it does not modify an existing Homebrew database or require a paid/Docker Desktop service.
 * Private generated connection settings live in ignored .runtime/postgres-access.json.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

/** Local bootstrap key is separate from the encrypted connection file. This prevents accidental
 * disclosure of that file, not compromise of this OS user. Use FileVault/EBS encryption as well.
 * Production does not use this bootstrap: its credentials come from mounted Secrets Manager files.
 */
function localConfigurationKey(create: boolean): Buffer {
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(runtimeDirectory).isSymbolicLink()) {
    throw new Error("Local runtime directory must not be a symlink.");
  }
  chmodSync(runtimeDirectory, 0o700);
  const path = resolve(runtimeDirectory, "postgres.key");
  if (create && !existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error("Local database key must be a regular file.");
  }
  chmodSync(path, 0o600);
  const key = readFileSync(path);
  if (key.length !== 32) {
    throw new Error("Invalid local database key.");
  }
  return key;
}

/** Atomically replace legacy plaintext only after writing an authenticated encrypted envelope.
 * Never rotate keys/passwords implicitly: existing clusters must remain recoverable.
 */
function saveLocalConfiguration(
  config: LocalPostgresConfiguration,
  replace = false,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localConfigurationKey(true), iv);
  cipher.setAAD(Buffer.from("nraialgo:local-postgres:v1"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config)),
    cipher.final(),
  ]);
  const envelope = JSON.stringify({
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  if (!replace) {
    writeFileSync(configurationPath, envelope, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    return;
  }
  const temporary = `${configurationPath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, envelope, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, configurationPath);
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

/** Read the private local connection file without ever logging its passwords. */
export function readLocalPostgresConfiguration(): LocalPostgresConfiguration | null {
  if (!existsSync(configurationPath)) {
    return null;
  }
  if (
    !lstatSync(configurationPath).isFile() ||
    lstatSync(configurationPath).isSymbolicLink()
  ) {
    throw new Error("Local database configuration must be a regular file.");
  }
  chmodSync(configurationPath, 0o600);
  const stored = JSON.parse(readFileSync(configurationPath, "utf8"));
  let config: LocalPostgresConfiguration;
  if (stored.version !== undefined) {
    if (stored.version !== 1) {
      throw new Error("Unsupported local database configuration.");
    }
    const cipher = createDecipheriv(
      "aes-256-gcm",
      localConfigurationKey(false),
      Buffer.from(stored.iv, "base64"),
    );
    cipher.setAAD(Buffer.from("nraialgo:local-postgres:v1"));
    cipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    config = JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(stored.ciphertext, "base64")),
        cipher.final(),
      ]).toString("utf8"),
    );
  } else {
    config = stored;
  }
  if (
    !config.adminUrl ||
    !config.applicationUrl ||
    !config.applicationPassword ||
    !Number.isInteger(config.port)
  ) {
    throw new Error("Invalid local PostgreSQL configuration.");
  }
  if (stored.version === undefined) {
    saveLocalConfiguration(config, true);
  }
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
  if (!directory) {
    throw new Error(
      "Install PostgreSQL 17 (macOS: brew install postgresql@17), or set PG_BIN.",
    );
  }
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
  if (result.error || result.status !== 0) {
    throw new Error(
      `PostgreSQL ${name} failed. Check .runtime/postgres.log and the configured local port.`,
    );
  }
}

/** Return whether the configured PostgreSQL server already accepts authenticated connections.
 * This network-level check is more reliable than pg_ctl status inside restricted test runners.
 */
async function isPostgresReachable(adminUrl: string): Promise<boolean> {
  const client = new pg.Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 1000,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
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
    saveLocalConfiguration(config);
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
  const adminUrl = new URL(config.adminUrl);
  adminUrl.pathname = "/postgres";
  if (!(await isPostgresReachable(adminUrl.toString()))) {
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
  }
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
    ) {
      await client.query("CREATE DATABASE nralgo");
    }
  } finally {
    await client.end();
  }
  return config;
}
/** Stop the known project cluster only; never stop another PostgreSQL service on the machine. */
export function stopLocalPostgres() {
  if (existsSync(resolve(clusterDirectory, "PG_VERSION"))) {
    runPostgresUtility("pg_ctl", [
      "-D",
      clusterDirectory,
      "-m",
      "fast",
      "-w",
      "stop",
    ]);
  }
}

/** Defer CLI execution until both database modules finish loading. The migration adapter
 * reads local settings from this module, so awaiting its import during evaluation deadlocks.
 */
async function runLocalDatabaseCommand() {
  if (process.argv.includes("--stop")) {
    stopLocalPostgres();
  } else {
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
    console.debug("Local PostgreSQL ready on 127.0.0.1:55432.");
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
