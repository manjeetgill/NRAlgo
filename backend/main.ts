import express, { type ErrorRequestHandler, type Response } from 'express';
import { z } from 'zod';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { openStore, isMain, now, audit, lockSettings, type Store, type Query } from './database.js';
import type { Owner, LoginSession, Job, Strategy, Settings } from './types.js';

declare global {
  namespace Express { interface Locals { session: LoginSession } }
}

const seconds = () => Date.now() / 1000;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const equal = (a: unknown, b: unknown) => timingSafeEqual(Buffer.from(digest(String(a))), Buffer.from(digest(String(b))));
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  // 64-byte scrypt preserves login compatibility with existing Python hashes.
  return `${salt}:${scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
}
const fail = (status: number, detail: string): never => { throw Object.assign(new Error(detail), { status, detail }); };
const credentials = z.object({ username: z.string().min(3).max(80).regex(/^[a-zA-Z0-9_.@-]+$/), password: z.string().min(12).max(128), setup_token: z.string().max(200).default('') });
const strategyInput = z.object({
  name: z.string().trim().min(2).max(60), symbol: z.enum(['NIFTY', 'BANKNIFTY', 'SENSEX']).default('NIFTY'),
  capital: z.number().int().min(1000).max(500000), fast: z.number().int().min(2).max(40).default(9),
  slow: z.number().int().min(3).max(80).default(21), mode: z.literal('paper').default('paper'),
}).refine(s => s.fast < s.slow);

export function createApp(store: Store, env: NodeJS.ProcessEnv = process.env) {
  const production = env.APP_ENV === 'production';
  const origin = env.APP_ORIGIN || 'http://localhost:3000', setupToken = env.SETUP_TOKEN || '';
  let validOrigin = false;
  try { const u = new URL(origin); validOrigin = u.protocol === 'https:' && u.origin === origin; } catch {}
  if (production && (!validOrigin || setupToken.length < 32)) throw new Error('Production requires an HTTPS origin and 32+ character SETUP_TOKEN.');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin &&
        !(production ? [origin] : [origin, 'http://127.0.0.1:3000']).includes(req.headers.origin)) return res.status(403).json({ detail: 'Origin not allowed' });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  async function issueSession(q: Query, res: Response) {
    const raw = randomBytes(48).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    await q('DELETE FROM sessions WHERE expires<$1', [seconds()]);
    await q('INSERT INTO sessions (token_hash,csrf,expires) VALUES ($1,$2,$3)', [digest(raw), csrf, seconds() + 28800]);
    res.cookie('nexus_session', raw, { httpOnly: true, secure: production, sameSite: 'strict', maxAge: 28800000, path: '/' });
    return { csrf };
  }
  app.get('/api/health', async (req, res) => {
    try {
      await store.transaction(async q => { if (!(await q('SELECT id FROM settings WHERE id=1')).length) throw new Error(); });
      res.json({ status: 'ok', service: 'nexus-node', live_enabled: false });
    } catch { res.status(503).json({ detail: 'Database not ready' }); }
  });
  app.get('/api/auth/status', async (req, res) => res.json(await store.transaction(async q => ({
    setup_required: !(await q('SELECT id FROM owners WHERE id=1')).length, setup_token_required: Boolean(setupToken),
  }))));
  app.post('/api/auth/setup', async (req, res) => {
    const data = credentials.parse(req.body);
    if (setupToken && !equal(data.setup_token, setupToken)) fail(403, 'Invalid setup token.');
    res.json(await store.transaction(async q => {
      await lockSettings(q, store);
      if ((await q('SELECT id FROM owners WHERE id=1')).length) fail(409, 'Workspace already configured.');
      await q('INSERT INTO owners (id,username,password_hash,failed_logins,locked_until) VALUES (1,$1,$2,0,0)', [data.username, hashPassword(data.password)]);
      await audit(q, 'Owner account created. Paper workspace initialized.');
      return issueSession(q, res);
    }));
  });
  app.post('/api/auth/login', async (req, res) => {
    const data = credentials.parse(req.body);
    const result = await store.transaction(async q => {
      const [owner] = await q<Owner>(`SELECT * FROM owners WHERE id=1${store.postgres ? ' FOR UPDATE' : ''}`);
      if (!owner) fail(409, 'Create the workspace first.');
      if (owner.locked_until > seconds()) fail(429, 'Too many attempts. Try again in a minute.');
      if (!equal(hashPassword(data.password, owner.password_hash.split(':')[0]), owner.password_hash) || !equal(data.username, owner.username)) {
        const attempts = owner.failed_logins + 1;
        await q('UPDATE owners SET failed_logins=$1,locked_until=$2 WHERE id=1', [attempts >= 5 ? 0 : attempts, attempts >= 5 ? seconds() + 60 : owner.locked_until]);
        return null; // Commit failed attempts before sending the error.
      }
      await q('UPDATE owners SET failed_logins=0 WHERE id=1');
      await audit(q, 'Owner signed in.');
      return issueSession(q, res);
    });
    if (!result) fail(401, 'Incorrect username or password.');
    res.json(result);
  });
  app.use('/api', async (req, res, next) => {
    const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('nexus_session='))?.slice(14) || '';
    const [session] = await store.transaction(q => q<LoginSession>('SELECT * FROM sessions WHERE token_hash=$1', [digest(raw)]));
    if (!session || session.expires < seconds()) fail(401, 'Please sign in.');
    if (req.method !== 'GET' && !equal(req.headers['x-csrf-token'] || '', session.csrf)) fail(403, 'Session verification failed. Refresh and try again.');
    res.locals.session = session; next();
  });
  app.post('/api/auth/logout', async (req, res) => {
    await store.transaction(q => q('DELETE FROM sessions WHERE token_hash=$1', [res.locals.session.token_hash]));
    res.clearCookie('nexus_session', { path: '/', secure: production, httpOnly: true, sameSite: 'strict' }).json({ ok: true });
  });
  app.get('/api/workspace', async (req, res) => res.json(await store.transaction(async q => ({
    username: (await q<Owner>('SELECT username FROM owners WHERE id=1'))[0].username, csrf: res.locals.session.csrf,
    halted: Boolean((await q<Settings>('SELECT halted FROM settings WHERE id=1'))[0].halted),
    strategies: await q('SELECT id,name,symbol,fast,slow,capital,status,pnl FROM strategies ORDER BY created_at DESC'),
    jobs: (await q<Job>('SELECT id,strategy_id,status,created_at,result FROM jobs ORDER BY created_at DESC LIMIT 30')).map(j => ({ ...j, result: JSON.parse(j.result) })),
    events: await q('SELECT * FROM events ORDER BY id DESC LIMIT 50'),
  }))));
  app.post('/api/strategies', async (req, res) => {
    const s = strategyInput.parse(req.body), id = randomUUID();
    await store.transaction(async q => {
      await q("INSERT INTO strategies (id,name,symbol,fast,slow,capital,status,pnl,created_at) VALUES ($1,$2,$3,$4,$5,$6,'draft',0,$7)", [id,s.name,s.symbol,s.fast,s.slow,s.capital,now()]);
      await audit(q, `Created strategy: ${s.name} · ${s.symbol} · EMA ${s.fast}/${s.slow}.`);
    });
    res.status(201).json({ id });
  });
  app.post('/api/strategies/:id/run', async (req, res) => {
    const id = randomUUID();
    await store.transaction(async q => {
      if ((await lockSettings(q, store)).halted) fail(409, 'Workspace is paused. Resume before starting a replay.');
      const [s] = await q<Strategy>('SELECT * FROM strategies WHERE id=$1', [String(req.params.id)]);
      if (!s || ['queued','running'].includes(s.status)) fail(409, 'Strategy not found or already queued/running.');
      await q("UPDATE strategies SET status='queued' WHERE id=$1", [s.id]);
      await q("INSERT INTO jobs (id,strategy_id,status,result,created_at,updated_at) VALUES ($1,$2,'queued','{}',$3,$4)", [id,s.id,now(),now()]);
      await audit(q, `Queued sample-data replay for ${s.name}.`);
    });
    res.status(202).json({ id });
  });
  app.post('/api/controls', async (req, res) => {
    const { halted } = z.object({ halted: z.boolean() }).parse(req.body);
    await store.transaction(async q => {
      await lockSettings(q, store);
      await q('UPDATE settings SET halted=$1 WHERE id=1', [halted]);
      if (halted) {
        await q("UPDATE jobs SET status='cancelled' WHERE status IN ('queued','running')");
        await q("UPDATE strategies SET status='paused' WHERE status IN ('queued','running')");
      }
      await audit(q, halted ? 'Paused all paper work. Pending replays cancelled.' : 'Paper workspace resumed.');
    });
    res.json({ ok: true });
  });
  app.use((req, res) => res.status(404).json({ detail: 'Not found' }));
  const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
    const error = err as { status?: number; code?: string; name?: string; detail?: string };
    const status = err instanceof z.ZodError ? 422 : (error.status || 500);
    if (status === 500) console.error('API request failed:', error.code || error.name);
    res.status(status).json({ detail: err instanceof z.ZodError ? 'Invalid request fields.' : error.detail || (status === 413 ? 'Request too large' : status === 400 ? 'Invalid JSON' : 'Request failed') });
  };
  app.use(errorHandler);
  return app;
}
if (isMain(import.meta.url)) {
  const store = openStore();
  const app = createApp(store);
  const server = app.listen(Number(process.env.PORT || 8000), process.env.API_HOST || '127.0.0.1', () => console.log('Node.js API ready.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(async () => { await store.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
