import { setTimeout as delay } from 'node:timers/promises';
import { openStore, isMain, now, audit, lockSettings } from './database.mjs';
import { replay } from './simulator.mjs';

export async function recover(store) {
  await store.transaction(async q => {
    await lockSettings(q, store);
    await q("UPDATE jobs SET status='queued' WHERE status='running'");
    await q("UPDATE strategies SET status='queued' WHERE status='running'");
  });
}
export async function processOne(store) {
  const work = await store.transaction(async q => {
    if ((await lockSettings(q, store)).halted) return null;
    const [job] = await q("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1");
    if (!job) return null;
    await q("UPDATE jobs SET status='running',updated_at=$1 WHERE id=$2", [now(), job.id]);
    await q("UPDATE strategies SET status='running' WHERE id=$1", [job.strategy_id]);
    const [strategy] = await q('SELECT * FROM strategies WHERE id=$1', [job.strategy_id]);
    return { job, strategy };
  });
  if (!work) return false;
  try {
    const { job, strategy: s } = work;
    const result = replay(s.symbol, s.capital, s.fast, s.slow);
    await store.transaction(async q => {
      const settings = await lockSettings(q, store);
      const [current] = await q('SELECT status FROM jobs WHERE id=$1', [job.id]);
      if (settings.halted || current.status !== 'running') return;
      await q("UPDATE jobs SET status='completed',result=$1,updated_at=$2 WHERE id=$3", [JSON.stringify(result), now(), job.id]);
      await q("UPDATE strategies SET status='ready',pnl=$1 WHERE id=$2", [result.pnl, s.id]);
      await audit(q, `Completed sample-data replay: ${s.name}. ${result.trades.length} simulated fills.`);
    });
  } catch {
    await store.transaction(async q => {
      await lockSettings(q, store);
      const [job] = await q('SELECT status FROM jobs WHERE id=$1', [work.job.id]);
      if (job.status !== 'running') return;
      await q("UPDATE jobs SET status='failed' WHERE id=$1", [work.job.id]);
      await q("UPDATE strategies SET status='failed' WHERE id=$1", [work.strategy.id]);
      await audit(q, 'Paper replay failed. Check worker logs and retry.');
    });
    console.error('Paper replay failed.');
  }
  return true;
}
if (isMain(import.meta.url)) {
  const store = openStore();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
  try {
    await recover(store);
    console.log('Node.js paper replay worker ready. Run exactly one worker.');
    while (!stopping) if (!await processOne(store)) await delay(1000);
  } finally { await store.close(); }
}
