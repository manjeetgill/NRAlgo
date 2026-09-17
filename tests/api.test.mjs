import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, migrate } from '../backend/database.mjs';
import { createApp, hashPassword } from '../backend/main.mjs';
import { processOne, recover } from '../backend/worker.mjs';
import { replay } from '../backend/simulator.mjs';
import { createBreezeData, loadBreeze } from '../backend/breeze.mjs';
import { createRequire } from 'node:module';

const creds = { username: 'testowner', password: 'test-password-long' };
test('production cannot fall back to a local database', () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = 'production';
  try {
    assert.throws(() => openStore(''), /PostgreSQL/);
    assert.throws(() => openStore('sqlite://:memory:'), /PostgreSQL/);
  } finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
  }
  assert.throws(() => openStore('https://example.com'), /Unsupported/);
});
async function fixture(t, env = {}) {
  const store = openStore('sqlite://:memory:');
  await migrate(store);
  const app = createApp(store, env);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let cookie = '', csrf = '';
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await response.json();
    if (data.csrf) csrf = data.csrf;
    return { status: response.status, data, headers: response.headers };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  return { store, request, owner: () => request('/api/auth/setup', 'POST', creds) };
}
const strategy = { name: 'Momentum test', symbol: 'NIFTY', capital: 100000, fast: 9, slow: 21 };

test('owner authentication, CSRF, origin rejection and logout', async t => {
  const { request, owner } = await fixture(t);
  assert.equal((await request('/api/workspace')).status, 401);
  assert.equal((await owner()).status, 200);
  assert.equal((await owner()).status, 409);
  assert.equal((await request('/api/strategies', 'POST', strategy, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await request('/api/controls', 'POST', { halted: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/auth/logout', 'POST', {})).status, 200);
  assert.equal((await request('/api/workspace')).status, 401);
});
test('validation and live orders disabled', async t => {
  const { request, owner } = await fixture(t); await owner();
  for (const fields of [{ capital: -5 }, { capital: 500001 }, { capital: '10000' }, { fast: 30, slow: 10 }, { name: '  ' }, { mode: 'live' }]) {
    assert.equal((await request('/api/strategies', 'POST', { ...strategy, ...fields })).status, 422);
  }
  assert.equal((await request('/api/health')).data.live_enabled, false);
});
test('replay end-to-end, duplicate prevention and login persistence', async t => {
  const { request, owner, store } = await fixture(t); await owner();
  const { data: { id } } = await request('/api/strategies', 'POST', strategy);
  const statuses = await Promise.all([1,2].map(async () => (await request(`/api/strategies/${id}/run`, 'POST', {})).status));
  assert.deepEqual(statuses.sort(), [202,409]);
  assert.equal(await processOne(store), true);
  const data = (await request('/api/workspace')).data;
  assert.equal(data.jobs[0].status, 'completed');
  const result = data.jobs[0].result;
  assert.equal(result.equity.length, 240); assert.ok(result.trades.length);
  assert.equal(result.source, 'synthetic');
  assert.ok(Math.abs(result.trades.reduce((s,t) => s + (t.pnl || 0), 0) - result.pnl) < .02);
  assert.equal(await processOne(store), false);
  await request('/api/auth/logout', 'POST', {});
  assert.equal((await request('/api/auth/login', 'POST', creds)).status, 200);
  assert.equal((await request('/api/workspace')).data.strategies[0].id, id);
});
test('pause cancels work, blocks new work and can resume', async t => {
  const { request, owner, store } = await fixture(t); await owner();
  const { data: { id } } = await request('/api/strategies', 'POST', strategy);
  await request(`/api/strategies/${id}/run`, 'POST', {});
  await request('/api/controls', 'POST', { halted: true });
  assert.equal(await processOne(store), false);
  assert.equal((await request('/api/workspace')).data.jobs[0].status, 'cancelled');
  assert.equal((await request(`/api/strategies/${id}/run`, 'POST', {})).status, 409);
  await request('/api/controls', 'POST', { halted: false });
  assert.equal((await request(`/api/strategies/${id}/run`, 'POST', {})).status, 202);
});
test('login failures commit and throttle', async t => {
  const { request, owner } = await fixture(t); await owner();
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/auth/login', 'POST', { ...creds, password: 'wrong-password-long' })).status, 401);
  assert.equal((await request('/api/auth/login', 'POST', creds)).status, 429);
});
test('production setup token and secure cookie', async t => {
  const token = 'x'.repeat(64);
  const { request } = await fixture(t, { APP_ENV: 'production', APP_ORIGIN: 'https://algo.example.com', SETUP_TOKEN: token });
  assert.equal((await request('/api/auth/setup', 'POST', creds)).status, 403);
  const response = await request('/api/auth/setup', 'POST', { ...creds, setup_token: token });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
});
test('production config rejects unsafe origins and short tokens', () => {
  for (const origin of ['http://example.com', 'https://example.com/path', 'https://user@example.com']) assert.throws(() => createApp({}, { APP_ENV: 'production', APP_ORIGIN: origin, SETUP_TOKEN: 'x'.repeat(64) }));
  assert.throws(() => createApp({}, { APP_ENV: 'production', APP_ORIGIN: 'https://example.com', SETUP_TOKEN: 'short' }));
});
test('health detects unavailable schema, request body is bounded', async t => {
  const { request, store } = await fixture(t);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/auth/setup', 'POST', { password: 'x'.repeat(17000) })).status, 413);
  await store.transaction(q => q('DELETE FROM settings'));
  assert.equal((await request('/api/health')).status, 503);
});
test('migrations preserve legacy rows and password hashes', async t => {
  const { store, request } = await fixture(t);
  const salt = '0123456789abcdef0123456789abcdef';
  const hash = hashPassword(creds.password, salt);
  assert.equal(hash.split(':')[1].length, 128);
  await store.transaction(async q => {
    await q('INSERT INTO owners VALUES (1,$1,$2,0,0)', [creds.username, hash]);
    await q('DROP TABLE schema_migrations'); // Emulate the previous schema, before JS migration tracking.
  });
  await migrate(store); await migrate(store);
  assert.equal((await request('/api/auth/login', 'POST', creds)).status, 200);
});
test('restart recovery requeues interrupted jobs', async t => {
  const { store, owner, request } = await fixture(t); await owner();
  const { data: { id } } = await request('/api/strategies', 'POST', strategy);
  await request(`/api/strategies/${id}/run`, 'POST', {});
  await store.transaction(q => q("UPDATE jobs SET status='running'"));
  await recover(store); assert.equal(await processOne(store), true);
});
test('synthetic results deterministic and no unfunded fills', () => {
  assert.deepEqual(replay('NIFTY', 100000, 9, 21), replay('NIFTY', 100000, 9, 21));
  assert.deepEqual(replay('SENSEX', 1000, 9, 21).trades, []);
});
test('Breeze wrapper has no order interface and redacts SDK errors', async () => {
  class Fake {
    async generateSession() {}
    async getHistoricalDatav2() { return { Status: 200, Success: [{ close: 42 }] }; }
  }
  const adapter = createBreezeData({ apiKey: 'fake', apiSecret: 'fake', sessionToken: 'fake' }, Fake);
  assert.equal(adapter.placeOrder, undefined);
  await assert.rejects(adapter.historical({}), /Connect/);
  await adapter.connect(); assert.deepEqual(await adapter.historical({}), [{ close: 42 }]);
  adapter.disconnect();
  class Failed { async generateSession() { throw new Error('SECRET'); } }
  const failed = createBreezeData({ apiKey: 'fake', apiSecret: 'fake', sessionToken: 'fake' }, Failed);
  await assert.rejects(failed.connect(), error => !error.message.includes('SECRET'));
});
test('real SDK keeps TLS enabled and patched HTTP/CSV/ZIP dependencies load', async () => {
  const Client = loadBreeze();
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '1');
  const require = createRequire(import.meta.url);
  const axios = require('axios');
  const previous = axios.defaults.adapter;
  axios.defaults.adapter = async config => ({ data: { Status: 200, Success: [{ close: 42 }] }, status: 200, statusText: 'OK', headers: {}, config });
  try {
    const sdk = new Client({ appKey: 'fake' });
    const result = await sdk.getHistoricalDatav2({ interval: '1minute', fromDate: '2026-09-01T09:15:00.000Z', toDate: '2026-09-01T09:16:00.000Z', stockCode: 'RELIND', exchangeCode: 'NSE', productType: 'cash' });
    assert.equal(result.Status, 200);
    assert.equal(require('csv-parse/sync').parse('a,b\n1,2', { columns: true })[0].a, '1');
    const Zip = require('adm-zip'), zip = new Zip(); zip.addFile('test.csv', Buffer.from('a,b'));
    assert.equal(new Zip(zip.toBuffer()).getEntry('test.csv').getData().toString(), 'a,b');
  } finally { axios.defaults.adapter = previous; }
});
