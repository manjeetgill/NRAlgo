/** Retired replay implementation retained for isolated legacy-record regression tests only.
 * Public enqueue and standalone startup are disabled; this never drives application screens.
 */
import {
  isEntryPoint,
  now,
  audit,
  lockWorkspaceSettings,
  type Store,
} from "./database.js";
import { simulateSyntheticStrategy } from "./simulator.js";
import type { Job, Strategy } from "./types.js";

/** Acquire or refresh the singleton worker lease, rejecting an existing healthy worker. */
export async function refreshWorkerLease(store: Store, instanceId: string) {
  await store.transaction(async (query) => {
    await lockWorkspaceSettings(query, store);
    const [row] = await query<{ instance_id: string; heartbeat: number }>(
      "SELECT * FROM worker_health WHERE id=1",
    );
    if (
      row &&
      row.instance_id !== instanceId &&
      Date.now() / 1000 - row.heartbeat < 30
    ) {
      throw new Error("Another worker holds the execution lease.");
    }
    await query(
      "INSERT INTO worker_health VALUES (1,$1,$2) ON CONFLICT(id) DO UPDATE SET instance_id=$1,heartbeat=$2",
      [instanceId, Date.now() / 1000],
    );
  });
}
/** Fence off stale workers before claiming or committing jobs. Tests may omit a running lease. */
async function assertLease(
  query: import("./database.js").Query,
  instanceId?: string,
) {
  if (!instanceId) {
    return;
  }
  const [row] = await query<{ instance_id: string; heartbeat: number }>(
    "SELECT * FROM worker_health WHERE id=1",
  );
  if (
    !row ||
    row.instance_id !== instanceId ||
    Date.now() / 1000 - row.heartbeat >= 30
  ) {
    throw new Error("Worker lease lost.");
  }
}
/** Requeue interrupted synthetic jobs only after taking over the worker lease.
 * Never reuse this replay recovery model for live orders, which need broker reconciliation.
 */
export async function recoverInterruptedPaperJobs(
  store: Store,
  instanceId?: string,
) {
  await store.transaction(async (query) => {
    await lockWorkspaceSettings(query, store);
    await assertLease(query, instanceId);
    await query("UPDATE jobs SET status='queued' WHERE status='running'");
    await query("UPDATE strategies SET status='queued' WHERE status='running'");
  });
}
/** Claim one tenant-owned job, compute outside the transaction and publish only if still authorized.
 * Returns false when no work is available so the outer loop can sleep without busy-polling.
 */
export async function processNextPaperJob(store: Store, instanceId?: string) {
  const work = await store.transaction(async (query) => {
    await lockWorkspaceSettings(query, store);
    await assertLease(query, instanceId);
    const [job] = await query<Job>(
      "SELECT j.* FROM jobs j JOIN user_settings s ON j.user_id=s.user_id WHERE j.status='queued' AND s.halted=$1 ORDER BY j.created_at LIMIT 1",
      [false],
    );
    if (!job) {
      return null;
    }
    if ((await lockWorkspaceSettings(query, store, job.user_id)).halted) {
      return null;
    }
    await query("UPDATE jobs SET status='running',updated_at=$1 WHERE id=$2", [
      now(),
      job.id,
    ]);
    await query("UPDATE strategies SET status='running' WHERE id=$1", [
      job.strategy_id,
    ]);
    const [strategy] = await query<Strategy>(
      "SELECT * FROM strategies WHERE id=$1 AND user_id=$2",
      [job.strategy_id, job.user_id],
    );
    return { job, strategy };
  });
  if (!work) {
    return false;
  }
  try {
    const { job, strategy } = work;
    const result = simulateSyntheticStrategy(
      strategy.symbol,
      strategy.capital,
      strategy.fast,
      strategy.slow,
    );
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store);
      await assertLease(query, instanceId);
      const settings = await lockWorkspaceSettings(query, store, job.user_id);
      const [current] = await query("SELECT status FROM jobs WHERE id=$1", [
        job.id,
      ]);
      if (settings.halted || current.status !== "running") {
        return;
      }
      await query(
        "UPDATE jobs SET status='completed',result=$1,updated_at=$2 WHERE id=$3",
        [JSON.stringify(result), now(), job.id],
      );
      await query("UPDATE strategies SET status='ready',pnl=$1 WHERE id=$2", [
        result.pnl,
        strategy.id,
      ]);
      await audit(
        query,
        `Completed sample-data replay: ${strategy.name}. ${result.trades.length} simulated fills.`,
        job.user_id,
      );
      await query(
        "DELETE FROM jobs WHERE user_id=$1 AND status NOT IN ('queued','running') AND id NOT IN (SELECT id FROM jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1000)",
        [job.user_id],
      );
    });
  } catch {
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store);
      await assertLease(query, instanceId);
      await lockWorkspaceSettings(query, store, work.job.user_id);
      const [job] = await query("SELECT status FROM jobs WHERE id=$1", [
        work.job.id,
      ]);
      if (job.status !== "running") {
        return;
      }
      await query("UPDATE jobs SET status='failed' WHERE id=$1", [work.job.id]);
      await query("UPDATE strategies SET status='failed' WHERE id=$1", [
        work.strategy.id,
      ]);
      await audit(
        query,
        "Paper replay failed. Check worker logs and retry.",
        work.job.user_id,
      );
    });
    console.error("Paper replay failed.");
  }
  return true;
}
/** Importable only for legacy migration tests; normal startup cannot consume generated-price jobs. */
if (isEntryPoint(import.meta.url)) {
  throw new Error(
    "Legacy replay worker retired. Use real historical research APIs.",
  );
}
