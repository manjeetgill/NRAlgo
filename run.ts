/** Local-only launcher: runDatabaseMigrations first, start API/worker/Next.js, then open a healthy browser page.
 * Child processes share the environment but remain independently stoppable process groups.
 */
import { spawn, type ChildProcess } from "node:child_process";
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
if (localPostgres) process.env.DATABASE_URL = localPostgres.applicationUrl;
const children: ChildProcess[] = [];
let stopping = false;
/** Stop the entire development stack once; escalate to SIGKILL only for our unresponsive children. */
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
  }, 30000).unref();
}
const commands: [string, string[], string][] = [
  [process.execPath, ["--import", "tsx", "backend/main.ts"], root],
  [process.execPath, ["--import", "tsx", "backend/worker.ts"], root],
  ["npm", ["run", "dev"], `${root}frontend`],
];
for (const [command, args, cwd] of commands) {
  const child = spawn(command, args, { cwd, stdio: "inherit", detached: true });
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
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
console.log("NRAlgo: http://localhost:3000");
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
          console.log("Open http://localhost:3000 in your browser."),
        );
        break;
      }
    } catch {}
    await delay(1000);
  }
}
