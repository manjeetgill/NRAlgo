import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const now = () => new Date().toISOString();
export const isMain = (url) => process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;

// Parameterized SQL, same table names/types as the original Python application.
// SQLite's single connection is serialized across async request handlers.
export function openStore(url = process.env.DATABASE_URL) {
  const postgres = Boolean(url && /^(postgres|postgresql|postgresql\+psycopg):\/\//.test(url));
  if (process.env.APP_ENV === 'production' && !postgres) {
    throw new Error('Production requires a PostgreSQL DATABASE_URL; SQLite is local-only.');
  }
  if (url && !postgres && !url.startsWith('sqlite://')) throw new Error('Unsupported DATABASE_URL scheme.');
  const filename = url ? url.replace(/^sqlite:\/\//, '') : resolve(root, '.runtime/workspace.db');
  if (!postgres && filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = postgres ? null : new DatabaseSync(filename);
  sqlite?.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;');
  const pool = postgres ? new pg.Pool({ connectionString: url.replace('postgresql+psycopg:', 'postgresql:'), max: 5 }) : null;
  let tail = Promise.resolve();
  const store = {
    postgres,
    async transaction(fn) {
      let release;
      const previous = tail;
      tail = new Promise(r => { release = r; });
      await previous;
      let client;
      try {
        client = pool ? await pool.connect() : null;
        const query = async (sql, params = []) => {
          if (client) return (await client.query(sql, params)).rows;
          const args = [];
          const statement = sqlite.prepare(sql.replace(/\$(\d+)/g, (_, n) => {
            const value = params[Number(n) - 1];
            args.push(typeof value === 'boolean' ? Number(value) : value);
            return '?';
          }));
          return statement.all(...args);
        };
        await query(postgres ? 'BEGIN' : 'BEGIN IMMEDIATE');
        try {
          const value = await fn(query);
          await query('COMMIT');
          return value;
        } catch (error) { await query('ROLLBACK'); throw error; }
      } finally { client?.release(); release(); }
    },
    async close() { await tail; sqlite?.close(); await pool?.end(); },
  };
  return store;
}

export async function migrate(store) {
  await store.transaction(async q => {
    if (store.postgres) await q('SELECT pg_advisory_xact_lock(684201)');
    await q('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    if ((await q('SELECT version FROM schema_migrations WHERE version=1')).length) return;
    const eventId = store.postgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    for (const sql of [
      'CREATE TABLE IF NOT EXISTS owners (id INTEGER PRIMARY KEY, username VARCHAR(80) UNIQUE NOT NULL, password_hash TEXT NOT NULL, failed_logins INTEGER NOT NULL, locked_until DOUBLE PRECISION NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sessions (token_hash VARCHAR(64) PRIMARY KEY, csrf VARCHAR(100) NOT NULL, expires DOUBLE PRECISION NOT NULL)',
      'CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, halted BOOLEAN NOT NULL)',
      'CREATE TABLE IF NOT EXISTS strategies (id VARCHAR(36) PRIMARY KEY, name VARCHAR(60) NOT NULL, symbol VARCHAR(20) NOT NULL, fast INTEGER NOT NULL, slow INTEGER NOT NULL, capital INTEGER NOT NULL, status VARCHAR(20) NOT NULL, pnl DOUBLE PRECISION NOT NULL, created_at VARCHAR(40) NOT NULL)',
      "CREATE TABLE IF NOT EXISTS jobs (id VARCHAR(36) PRIMARY KEY, strategy_id VARCHAR(36) NOT NULL, status VARCHAR(20) NOT NULL, result TEXT NOT NULL, created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL)",
      `CREATE TABLE IF NOT EXISTS events (id ${eventId}, message TEXT NOT NULL, created_at VARCHAR(40) NOT NULL)`,
    ]) await q(sql);
    await q('INSERT INTO settings (id,halted) VALUES (1,$1) ON CONFLICT (id) DO NOTHING', [false]);
    await q('INSERT INTO schema_migrations (version) VALUES (1)');
  });
}
export const audit = (q, message) => q('INSERT INTO events (message,created_at) VALUES ($1,$2)', [message, now()]);
export const lockSettings = async (q, store) => (await q(`SELECT * FROM settings WHERE id=1${store.postgres ? ' FOR UPDATE' : ''}`))[0];

if (isMain(import.meta.url)) {
  const store = openStore();
  try { await migrate(store); console.log('Database migration complete.'); }
  finally { await store.close(); }
}
