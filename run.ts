/** Local-only launcher: runDatabaseMigrations first, start API/Next.js, then open a healthy browser page.
 * Child processes share the environment but remain independently stoppable process groups.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ensureLocalPostgres } from "./backend/local-database.js";
import {
  root,
  openDatabaseStore,
  runDatabaseMigrations,
} from "./backend/database.js";

const localPostgres = process.env.DATABASE_URL
  ? null
  : await ensureLocalPostgres();
const store = openDatabaseStore(
  localPostgres?.adminUrl ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL,
);
try {
  await runDatabaseMigrations(store, {
    runtimePassword:
      localPostgres?.applicationPassword || process.env.APP_DATABASE_PASSWORD,
  });
} finally {
  await store.close();
}
if (localPostgres) {
  process.env.DATABASE_URL = localPostgres.applicationUrl;
}
const children: ChildProcess[] = [];
let stopping = false;
const python = `${root}.runtime/python-venv/bin/python`;
if (!existsSync(python)) {
  throw new Error(
    "Python calculation environment is missing. Run `make install` first.",
  );
}
process.env.CALCULATION_SERVICE_TOKEN ||=
  "local-development-calculation-token-change-me";
/** Stop the entire development stack once; escalate to SIGKILL only for our unresponsive children. */
function stop(code = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode !== null) {
      continue;
    }
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) {
        try {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {}
      }
    }
  }, 30000).unref();
}
const commands: [string, string[], string, NodeJS.ProcessEnv?][] = [
  [
    python,
    [
      "-m",
      "uvicorn",
      "calculation_engine.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      "8010",
      "--no-server-header",
    ],
    root,
  ],
  [process.execPath, ["--import", "tsx", "backend/main.ts"], root],
  ["npm", ["run", "dev"], `${root}frontend`],
  [
    "npm",
    ["run", "dev", "--", "--port", "3002"],
    `${root}frontend`,
    { ...process.env, DATABASE_UI: "1" },
  ],
];
for (const [command, args, cwd, env] of commands) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    detached: true,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", () => {
    if (!stopping) {
      console.error("A service exited; stopping the workspace.");
      stop(1);
    }
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop());
}
console.debug("NRAlgo: http://localhost:3000");
console.debug("Database UI: http://localhost:3002");
if (process.env.NEXUS_NO_BROWSER !== "1") {
  for (let i = 0; i < 90 && !stopping; i++) {
    try {
      const health = await fetch("http://localhost:3000/api/health", {
        signal: AbortSignal.timeout(2000),
      }).then((r) => r.json());
      const page = await fetch("http://localhost:3000/", {
        signal: AbortSignal.timeout(3000),
      });
      if (
        health.service === "nexus-node" &&
        health.status === "ok" &&
        page.ok &&
        !stopping
      ) {
        const opener = spawn(
          process.platform === "darwin" ? "open" : "xdg-open",
          ["http://localhost:3000"],
          { stdio: "ignore" },
        );
        opener.on("error", () =>
          console.debug("Open http://localhost:3000 in your browser."),
        );
        break;
      }
    } catch {}
    await delay(1000);
  }
}
