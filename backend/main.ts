/** HTTP API for independent user workspaces. Authentication and CSRF middleware run
 * before all strategy, account and broker handlers. Every private query is scoped to
 * the authenticated session's user_id, never an owner ID supplied by the browser.
 */
import express, { type ErrorRequestHandler, type Response } from "express";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import {
  openDatabaseStore,
  isEntryPoint,
  now,
  audit,
  lockWorkspaceSettings,
  type Store,
  type Query,
} from "./database.js";
import {
  digest,
  equal,
  fail,
  passwordHash,
  rateLimit,
  credentialVault,
} from "./security.js";
import { registerBrokerRoutes, BrokerManager } from "./brokers.js";
import { registerResearchRoutes } from "./research-routes.js";
import { registerPaperRoutes } from "./paper-routes.js";
import { InstrumentCatalog } from "./instrument-master.js";
import { KotakDataManager } from "./kotak-data.js";
import { registerMfaRoutes, verifySecondFactor } from "./mfa.js";
import { IciciLiveManager } from "./live/icici-routes.js";
import type { IciciRpcFactory } from "./live/icici-adapter.js";
import type { User, LoginSession, Job, Strategy, Settings } from "./types.js";

declare global {
  namespace Express {
    interface Locals {
      session: LoginSession;
    }
  }
}
const seconds = () => Date.now() / 1000;
const credentials = z.object({
  username: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-zA-Z0-9_.@-]+$/),
  password: z.string().min(12).max(128),
  setup_token: z.string().max(200).default(""),
  invite_token: z.string().max(200).default(""),
  token: z.string().max(32).default(""),
});
const strategyInput = z
  .object({
    name: z.string().trim().min(2).max(60),
    symbol: z.enum(["NIFTY", "BANKNIFTY", "SENSEX"]).default("NIFTY"),
    capital: z.number().int().min(1000).max(500000),
    fast: z.number().int().min(2).max(40).default(9),
    slow: z.number().int().min(3).max(80).default(21),
    mode: z.literal("paper").default("paper"),
  })
  .refine((strategy) => strategy.fast < strategy.slow);

/** Validate deployment settings, construct dependencies and register middleware in security order.
 * Tests inject a disposable PostgreSQL schema and mocked broker manager.
 */
export function createApiApplication(
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
  brokers?: BrokerManager,
  liveRpcFactory?: IciciRpcFactory,
  liveTradingWindow?: () => boolean,
  kotakData?: KotakDataManager,
  instrumentCatalog?: InstrumentCatalog,
) {
  const production = env.APP_ENV === "production" || env.NODE_ENV === "production";
  const origin = env.APP_ORIGIN || "http://localhost:3000",
    setupToken = env.SETUP_TOKEN || "";
  let validOrigin = false;
  try {
    const u = new URL(origin);
    validOrigin = u.protocol === "https:" && u.origin === origin;
  } catch {}
  if (production && (!validOrigin || setupToken.length < 32))
    throw new Error(
      "Production requires an HTTPS origin and 32+ character SETUP_TOKEN.",
    );
  if (env.REGISTRATION_TOKEN && env.REGISTRATION_TOKEN.length < 32)
    throw new Error("REGISTRATION_TOKEN must contain at least 32 characters.");
  const vault = credentialVault(env);
  const brokerManager = brokers || new BrokerManager();
  const kotakManager = kotakData || new KotakDataManager();
  const liveManager = new IciciLiveManager(
    store,
    vault,
    liveRpcFactory,
    liveTradingWindow,
    env.ENABLE_LIVE_TRADING === "true",
  );
  const openRegistration =
    env.ALLOW_PUBLIC_REGISTRATION === "true" ||
    (!production && env.ALLOW_PUBLIC_REGISTRATION !== "false");
  const registrationEnabled =
    openRegistration || Boolean(env.REGISTRATION_TOKEN);
  const app = express();
  app.locals.shutdown = async () => {
    brokerManager.close();
    kotakManager.close();
    await liveManager.haltAll();
  };
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      !(production ? [origin] : [origin, "http://127.0.0.1:3000"]).includes(
        req.headers.origin,
      )
    )
      return res.status(403).json({ detail: "Origin not allowed" });
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  // Caddy overwrites this header; use it only with the private, unexposed production API.
  const source = (req: express.Request) =>
    production && env.TRUST_EDGE_IP === "true"
      ? req.get("x-client-ip") || req.socket.remoteAddress || "unknown"
      : req.socket.remoteAddress || "unknown";
  app.use("/api/auth", rateLimit(40, 60000, source));
  let activeAuth = 0;
  app.use("/api/auth", (req, res, next) => {
    if (req.method !== "POST") return next();
    if (activeAuth >= 4)
      return res
        .status(429)
        .json({ detail: "Authentication busy. Try again shortly." });
    activeAuth++;
    let released = false;
    const release = () => {
      if (!released) {
        activeAuth--;
        released = true;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });
  /** Store only the token hash; deliver the opaque token in an HttpOnly cookie.
   * Limit active sessions to ten and return a separate CSRF token for mutations.
   */
  async function issueSession(query: Query, res: Response, userId: string) {
    const raw = randomBytes(48).toString("base64url"),
      csrf = randomBytes(32).toString("base64url");
    await query("DELETE FROM sessions WHERE expires<$1", [seconds()]);
    const existing = await query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY expires DESC",
      [userId],
    );
    for (const session of existing.slice(9))
      await query("DELETE FROM sessions WHERE token_hash=$1", [
        session.token_hash,
      ]);
    await query(
      "INSERT INTO sessions (token_hash,csrf,expires,user_id) VALUES ($1,$2,$3,$4)",
      [digest(raw), csrf, seconds() + 28800, userId],
    );
    res.cookie("nexus_session", raw, {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      maxAge: 28800000,
      path: "/",
    });
    return { csrf };
  }
  // Liveness checks the database, while readiness below also requires a fresh worker lease.
  app.get("/api/health", async (req, res) => {
    try {
      const worker = await store.transaction(async (query) => {
        if (!(await query("SELECT id FROM settings WHERE id=1")).length)
          throw new Error();
        const [row] = await query<{ heartbeat: number }>(
          "SELECT heartbeat FROM worker_health WHERE id=1",
        );
        return Boolean(row && seconds() - row.heartbeat < 30);
      });
      res.json({
        status: "ok",
        service: "nexus-node",
        live_enabled: false,
        live_capability:
          env.ENABLE_LIVE_TRADING === "true"
            ? "icici-cash-confirmed-orders"
            : "disabled-paper-only",
        worker: worker ? "healthy" : "unavailable",
      });
    } catch {
      res.status(503).json({ detail: "Database not ready" });
    }
  });
  app.get("/api/ready", async (req, res) => {
    const [row] = await store.transaction((query) =>
      query<{ heartbeat: number }>(
        "SELECT heartbeat FROM worker_health WHERE id=1",
      ),
    );
    const ready = Boolean(row && seconds() - row.heartbeat < 30);
    res
      .status(ready ? 200 : 503)
      .json({ ready, worker: ready ? "healthy" : "unavailable" });
  });
  app.get("/api/auth/status", async (req, res) =>
    res.json(
      await store.transaction(async (query) => ({
        setup_required: !(await query("SELECT id FROM users LIMIT 1")).length,
        setup_token_required: Boolean(setupToken),
        registration_enabled: registrationEnabled,
        invite_required: !openRegistration,
      })),
    ),
  );
  /** Bootstrap once with SETUP_TOKEN, or create an independent account under registration policy.
   * Hash outside the transaction; serialize the first-account decision to avoid setup races.
   */
  async function registerAccount(
    req: express.Request,
    res: Response,
    first: boolean,
  ) {
    const data = credentials.parse(req.body);
    if (first && setupToken && !equal(data.setup_token, setupToken))
      fail(403, "Invalid setup token.");
    if (
      !first &&
      (!registrationEnabled ||
        (!openRegistration &&
          !equal(data.invite_token, env.REGISTRATION_TOKEN)))
    )
      fail(403, "Registration requires a valid invitation.");
    const hashed = await passwordHash(data.password),
      userId = randomUUID();
    res.json(
      await store.transaction(async (query) => {
        await lockWorkspaceSettings(query, store);
        const exists = (await query("SELECT id FROM users LIMIT 1")).length > 0;
        if (first && exists)
          fail(
            409,
            "Workspace already configured. Sign in or create another account.",
          );
        if (!first && !exists)
          fail(409, "Complete first-account setup before registration.");
        if (
          (
            await query("SELECT id FROM users WHERE username=$1", [
              data.username,
            ])
          ).length
        )
          fail(409, "Username unavailable.");
        await query("INSERT INTO users VALUES ($1,$2,$3)", [
          userId,
          data.username,
          hashed,
        ]);
        await query("INSERT INTO user_settings VALUES ($1,$2)", [
          userId,
          false,
        ]);
        await audit(
          query,
          "Account created. Private paper workspace initialized.",
          userId,
        );
        return issueSession(query, res, userId);
      }),
    );
  }
  app.post("/api/auth/setup", (req, res) => registerAccount(req, res, true));
  app.post("/api/auth/register", rateLimit(5, 3600000, source), (req, res) =>
    registerAccount(req, res, false),
  );
  // Failed attempts are limited by source+username, never a shared victim-account counter.
  app.post(
    "/api/auth/login",
    rateLimit(
      5,
      60000,
      (req) => `${source(req)}:${String(req.body?.username).slice(0, 80)}`,
    ),
    async (req, res) => {
      const data = credentials.parse(req.body);
      const [user] = await store.transaction((query) =>
        query<User>("SELECT * FROM users WHERE username=$1", [data.username]),
      );
      const expected =
        user?.password_hash || "00000000000000000000000000000000:invalid";
      const valid = equal(
        await passwordHash(data.password, expected.split(":")[0]),
        expected,
      );
      if (!user || !valid) fail(401, "Incorrect username or password.");
      res.json(
        await store.transaction(async (query) => {
          await lockWorkspaceSettings(query, store, user.id);
          // Avoid accepting a password concurrently revoked by a password change.
          const [current] = await query<User>(
            "SELECT password_hash FROM users WHERE id=$1",
            [user.id],
          );
          if (!equal(current.password_hash, expected))
            fail(401, "Please sign in again.");
          await verifySecondFactor(query, vault, user.id, data.token);
          await audit(query, "Signed in.", user.id);
          return issueSession(query, res, user.id);
        }),
      );
    },
  );
  app.use("/api", async (req, res, next) => {
    const raw =
      (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("nexus_session="))
        ?.slice(14) || "";
    const [session] = await store.transaction((query) =>
      query<LoginSession>("SELECT * FROM sessions WHERE token_hash=$1", [
        digest(raw),
      ]),
    );
    if (!session || !session.user_id || session.expires < seconds())
      fail(401, "Please sign in.");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      !equal(req.headers["x-csrf-token"] || "", session.csrf)
    )
      fail(403, "Session verification failed. Refresh and try again.");
    res.locals.session = session;
    next();
  });
  const workspaceLimit = rateLimit(
    180,
    60000,
    (req) => req.res!.locals.session.user_id,
  );
  app.use("/api", (req, res, next) =>
    req.path === "/live/icici/halt" ? next() : workspaceLimit(req, res, next),
  );
  app.post("/api/auth/logout", async (req, res) => {
    await liveManager.halt(
      res.locals.session.user_id,
      "Signed out; live permission revoked",
    );
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, res.locals.session.user_id);
      await query("DELETE FROM sessions WHERE token_hash=$1", [res.locals.session.token_hash]);
    });
    brokerManager.disconnect(res.locals.session.user_id);
    kotakManager.disconnect(res.locals.session.user_id);
    res
      .clearCookie("nexus_session", {
        path: "/",
        secure: production,
        httpOnly: true,
        sameSite: "strict",
      })
      .json({ ok: true });
  });
  app.post("/api/auth/revoke-sessions", async (req, res) => {
    const { user_id, token_hash } = res.locals.session;
    await liveManager.halt(user_id, "Sessions revoked");
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, user_id);
      await query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [user_id, token_hash]);
    });
    brokerManager.disconnect(user_id);
    kotakManager.disconnect(user_id);
    res.json({ ok: true });
  });
  // Password changes require current-password/MFA proof and replace all existing sessions.
  app.post("/api/auth/password", async (req, res) => {
    const data = z
      .object({
        current_password: z.string().max(128),
        new_password: z.string().min(12).max(128),
        token: z.string().max(32).default(""),
      })
      .parse(req.body);
    const userId = res.locals.session.user_id;
    const [user] = await store.transaction((query) =>
      query<User>("SELECT * FROM users WHERE id=$1", [userId]),
    );
    if (
      !equal(
        await passwordHash(
          data.current_password,
          user.password_hash.split(":")[0],
        ),
        user.password_hash,
      )
    )
      fail(403, "Current password is incorrect.");
    const hashed = await passwordHash(data.new_password);
    const result = await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      const [current] = await query<User>(
        "SELECT password_hash FROM users WHERE id=$1",
        [userId],
      );
      if (!equal(current.password_hash, user.password_hash))
        fail(409, "Password changed. Sign in again.");
      await verifySecondFactor(query, vault, userId, data.token);
      await query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        hashed,
        userId,
      ]);
      await query("DELETE FROM sessions WHERE user_id=$1", [userId]);
      await audit(
        query,
        "Password changed; previous sessions revoked.",
        userId,
      );
      return issueSession(query, res, userId);
    });
    brokerManager.disconnect(userId);
    kotakManager.disconnect(userId);
    await liveManager.halt(userId, "Password changed");
    res.json(result);
  });
  // Browser snapshots are bounded and tenant-scoped; broker credentials never appear here.
  app.get("/api/workspace", async (req, res) => {
    const userId = res.locals.session.user_id;
    res.json(
      await store.transaction(async (query) => ({
        live_submission_enabled: env.ENABLE_LIVE_TRADING === "true",
        live_configured: Boolean(
          (
            await query(
              "SELECT id FROM live_accounts WHERE user_id=$1 AND broker_binding LIKE 'icici:%'",
              [userId],
            )
          ).length,
        ),
        username: (
          await query<User>("SELECT username FROM users WHERE id=$1", [userId])
        )[0].username,
        csrf: res.locals.session.csrf,
        halted: Boolean(
          (
            await query<Settings>(
              "SELECT halted FROM user_settings WHERE user_id=$1",
              [userId],
            )
          )[0].halted,
        ),
        strategies: await query(
          "SELECT id,name,symbol,fast,slow,capital,status,pnl FROM strategies WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
          [userId],
        ),
        jobs: (
          await query<Job>(
            "SELECT id,strategy_id,status,created_at,result FROM jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",
            [userId],
          )
        ).map((j) => ({ ...j, result: JSON.parse(j.result) })),
        events: await query(
          "SELECT id,message,created_at FROM events WHERE user_id=$1 ORDER BY id DESC LIMIT 50",
          [userId],
        ),
      })),
    );
  });
  // Apply account quotas while holding the account lock, including concurrent requests.
  app.post("/api/strategies", async (req, res) => {
    const strategy = strategyInput.parse(req.body),
      id = randomUUID(),
      userId = res.locals.session.user_id;
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      if (
        (
          await query("SELECT id FROM strategies WHERE user_id=$1 LIMIT 100", [
            userId,
          ])
        ).length >= 100
      )
        fail(409, "Limit: 100 strategies per account.");
      await query(
        "INSERT INTO strategies (id,name,symbol,fast,slow,capital,status,pnl,created_at,user_id) VALUES ($1,$2,$3,$4,$5,$6,'draft',0,$7,$8)",
        [
          id,
          strategy.name,
          strategy.symbol,
          strategy.fast,
          strategy.slow,
          strategy.capital,
          now(),
          userId,
        ],
      );
      await audit(
        query,
        `Created strategy: ${strategy.name} · ${strategy.symbol} · EMA ${strategy.fast}/${strategy.slow}.`,
        userId,
      );
    });
    res.status(201).json({ id });
  });
  app.post(
    "/api/strategies/:id/run",
    rateLimit(20, 60000, (req) => req.res!.locals.session.user_id),
    async (req, res) => {
      const id = randomUUID(),
        userId = res.locals.session.user_id;
      await store.transaction(async (query) => {
        if ((await lockWorkspaceSettings(query, store, userId)).halted)
          fail(409, "Workspace is paused. Resume before starting a replay.");
        const [strategy] = await query<Strategy>(
          "SELECT * FROM strategies WHERE id=$1 AND user_id=$2",
          [String(req.params.id), userId],
        );
        if (!strategy) fail(404, "Strategy not found.");
        if (["queued", "running"].includes(strategy.status))
          fail(409, "Strategy already queued/running.");
        await query(
          "UPDATE strategies SET status='queued' WHERE id=$1 AND user_id=$2",
          [strategy.id, userId],
        );
        await query(
          "INSERT INTO jobs (id,strategy_id,status,result,created_at,updated_at,user_id) VALUES ($1,$2,'queued','{}',$3,$4,$5)",
          [id, strategy.id, now(), now(), userId],
        );
        await audit(
          query,
          `Queued sample-data replay for ${strategy.name}.`,
          userId,
        );
      });
      res.status(202).json({ id });
    },
  );
  // This pauses only the caller's synthetic jobs, not exchange orders or other users' work.
  app.post("/api/controls", async (req, res) => {
    const { halted } = z.object({ halted: z.boolean() }).parse(req.body),
      userId = res.locals.session.user_id;
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      await query("UPDATE user_settings SET halted=$1 WHERE user_id=$2", [
        halted,
        userId,
      ]);
      if (halted) {
        await query(
          "UPDATE jobs SET status='cancelled' WHERE user_id=$1 AND status IN ('queued','running')",
          [userId],
        );
        await query(
          "UPDATE strategies SET status='paused' WHERE user_id=$1 AND status IN ('queued','running')",
          [userId],
        );
      }
      await audit(
        query,
        halted
          ? "Paused your paper work. Pending replays cancelled."
          : "Paper workspace resumed.",
        userId,
      );
    });
    res.json({ ok: true });
  });
  app.use("/api/auth/mfa", async (req, res, next) => {
    if (req.method === "POST" && req.path === "/disable")
      await liveManager.halt(res.locals.session.user_id, "MFA disabled");
    next();
  });
  registerMfaRoutes(app, store, vault, (userId) => {
    brokerManager.disconnect(userId);
    kotakManager.disconnect(userId);
  });
  // Replacing/removing saved broker credentials must first revoke live authorization.
  app.use("/api/brokers/icici", async (req, res, next) => {
    if (
      req.method === "DELETE" ||
      (req.method === "POST" && ["/connect", "/reconnect"].includes(req.path))
    )
      await liveManager.halt(
        res.locals.session.user_id,
        "Broker credentials changing",
      );
    next();
  });
  registerBrokerRoutes(app, store, vault, brokerManager, production);
  registerResearchRoutes(app, store, brokerManager, production);
  registerPaperRoutes(
    app,
    store,
    brokerManager,
    kotakManager,
    production,
    instrumentCatalog,
  );
  liveManager.register(app);
  app.use((req, res) => res.status(404).json({ detail: "Not found" }));
  const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
    const error = err as {
      status?: number;
      code?: string;
      name?: string;
      detail?: string;
    };
    const status = err instanceof z.ZodError ? 422 : error.status || 500;
    if (status >= 500)
      console.error("API request failed:", error.code || error.name);
    res.status(status).json({
      detail:
        err instanceof z.ZodError
          ? "Invalid request fields."
          : error.detail ||
            (status === 413
              ? "Request too large"
              : status === 400
                ? "Invalid JSON"
                : "Request failed"),
    });
  };
  app.use(errorHandler);
  return app;
}
if (isEntryPoint(import.meta.url)) {
  const store = openDatabaseStore(),
    app = createApiApplication(store);
  const server = app.listen(
    Number(process.env.PORT || 8000),
    process.env.API_HOST || "127.0.0.1",
    () => console.log("Node.js API ready."),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      setTimeout(() => process.exit(1), 25000).unref();
      await app.locals.shutdown();
      server.close(async () => {
        await store.close();
        process.exit(0);
      });
    });
}
