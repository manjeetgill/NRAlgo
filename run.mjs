import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { root, openStore, migrate } from './backend/database.mjs';

const store = openStore();
try { await migrate(store); } finally { await store.close(); }
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }, 10000).unref();
}
for (const [command, args, cwd] of [
  [process.execPath, ['backend/main.mjs'], root],
  [process.execPath, ['backend/worker.mjs'], root],
  ['npm', ['run', 'dev'], `${root}frontend`],
]) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', detached: true });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', () => { if (!stopping) { console.error('A service exited; stopping the workspace.'); stop(1); } });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
console.log('NRAlgo: http://localhost:3000');
if (process.env.NEXUS_NO_BROWSER !== '1') {
  for (let i = 0; i < 90 && !stopping; i++) {
    try {
      const health = await fetch('http://localhost:3000/api/health', { signal: AbortSignal.timeout(2000) }).then(r => r.json());
      const page = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(3000) });
      if (health.service === 'nexus-node' && health.status === 'ok' && page.ok && !stopping) {
        const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', ['http://localhost:3000'], { stdio: 'ignore' });
        opener.on('error', () => console.log('Open http://localhost:3000 in your browser.'));
        break;
      }
    } catch {}
    await delay(1000);
  }
}
