/** Authenticated ICICI routes and bounded per-account SDK workers.
 * SDKs run in separate threads because breezeconnect has shared mutable module globals.
 * Routes never return saved keys, secrets, tokens, signing headers or SDK exception bodies.
 */
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Express, Request } from "express";
import { audit, now, lockWorkspaceSettings, type Store } from "./database.js";
import { credentialVault, fail, rateLimit } from "./security.js";
import type { BreezeCredentials } from "./breeze.js";
import type { ResearchStreamSnapshot } from "./research-stream.js";

const credentials = z
  .object({
    apiKey: z.string().trim().min(8).max(256),
    apiSecret: z.string().trim().min(8).max(512),
    sessionToken: z
      .string()
      .trim()
      .min(4)
      .max(1024)
      .refine(
        (value) => !value.includes("://"),
        "Paste only the session token.",
      ),
  })
  .strict();
const instrument = z.object({
  stockCode: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9 &_.-]+$/),
  exchangeCode: z.enum(["NSE", "BSE", "NFO", "BFO"]),
  productType: z.enum(["cash", "futures", "options"]).default("cash"),
  expiryDate: z.iso.date().optional(),
  right: z.enum(["call", "put", "others"]).optional(),
  strikePrice: z
    .string()
    .max(20)
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
});
const historical = instrument.extend({
  interval: z.enum(["1minute", "5minute", "30minute", "1day"]),
  fromDate: z.iso.datetime(),
  toDate: z.iso.datetime(),
});
/** Validate exchange/product combinations before spending a broker request; formats differ by API. */
function validateInstrument(parameters: z.infer<typeof instrument>) {
  const derivativeExchange = ["NFO", "BFO"].includes(parameters.exchangeCode);
  if (derivativeExchange === (parameters.productType === "cash"))
    fail(422, "Use NSE/BSE for cash or NFO/BFO for derivatives.");
  if (parameters.productType !== "cash" && !parameters.expiryDate)
    fail(422, "Derivatives require an expiry date.");
  if (
    parameters.productType === "options" &&
    (!["call", "put"].includes(parameters.right || "") ||
      !parameters.strikePrice)
  )
    fail(422, "Options require Call/Put and a strike.");
  if (parameters.productType === "futures" && parameters.right !== "others")
    fail(422, "Select Others for futures.");
}
export interface BrokerConnection {
  researchSnapshot?(streamId: string): ResearchStreamSnapshot | null;
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
  snapshot(): { tick: unknown; receivedAt: number | null; state: string };
}
/** One isolated SDK realm. At most one RPC is active; a deadline terminates a stuck SDK. */
class ThreadConnection implements BrokerConnection {
  private worker: Worker;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private id = 0;
  private closed = false;
  private tick: unknown = null;
  private receivedAt: number | null = null;
  private state = "connected";
  private research: ResearchStreamSnapshot | null = null;
  /** Route sanitized responses/ticks to the owner and discard potentially sensitive SDK logs. */
  constructor(creds: BreezeCredentials) {
    // Use the compiled entry even in development. make run builds it before starting.
    this.worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist/backend/broker-thread.js"
          : "./broker-thread.js",
        import.meta.url,
      ),
      {
        workerData: creds,
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on("message", (message) => {
      if ("researchStream" in message) {
        this.research = message.researchStream;
        this.tick = null;
        this.receivedAt = null;
        this.state = ["stopped", "expired", "replaced"].includes(
          this.research!.state,
        )
          ? "connected"
          : "research basket";
        return;
      }
      if ("tick" in message) {
        this.tick = message.tick;
        this.receivedAt = Date.now();
        this.state = "streaming";
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            "Broker request failed. Renew your ICICI session and reconnect.",
          ),
        );
        this.close();
      } else pending.resolve(message.result);
    });
    this.worker.on("error", () => this.close());
    this.worker.on("exit", () => this.close());
  }
  /** Send a bounded RPC. Credential setup gets extra time for the SDK instrument download. */
  call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(
        new Error("Broker connection closed. Reconnect your account."),
      );
    if (this.pending.size)
      return Promise.reject(
        new Error("Another broker request is in progress."),
      );
    if (method === "subscribe" || method === "subscribeBasket") {
      this.tick = null;
      this.receivedAt = null;
      this.state = "waiting";
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.close();
        },
        method === "historical" ? 20000 : 90000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, params });
    });
  }
  /** Mark old quotes stale; a successful subscription is not proof of a current market price. */
  researchSnapshot(streamId: string) {
    if (this.closed || this.research?.streamId !== streamId) return null;
    this.worker.postMessage({ method: "streamHeartbeat", streamId });
    return {
      ...this.research,
      quotes: this.research.quotes.map((quote) => ({
        ...quote,
        stale:
          quote.stale ||
          !quote.observedAt ||
          Date.now() - quote.observedAt > 60000 ||
          Date.now() - quote.receivedAt > 30000,
      })),
    };
  }
  /** Single-instrument explorer status remains independent of the research basket cache. */
  snapshot() {
    return {
      tick: this.tick,
      receivedAt: this.receivedAt,
      state: this.closed
        ? "disconnected"
        : this.receivedAt && Date.now() - this.receivedAt > 30000
          ? "stale"
          : this.state,
    };
  }
  /** Idempotently terminate sockets/SDK state and reject pending callers with a redacted error. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.research = null;
    this.tick = null;
    this.receivedAt = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          "Broker connection ended or timed out. Reconnect your account.",
        ),
      );
    }
    this.pending.clear();
    void this.worker.terminate();
  }
}

/** Low-cost single-server registry: three active accounts, one explorer/basket data feed each. */
export class BrokerManager {
  private connections = new Map<
    string,
    { connection: BrokerConnection; touched: number; expires: number; ready: boolean }
  >();
  private busy = new Set<string>();
  private closed = false;
  private cleanup: NodeJS.Timeout;
  /** Inject a fake connection in tests; expire inactive connections and expired app sessions. */
  constructor(
    private factory: (creds: BreezeCredentials) => BrokerConnection = (creds) =>
      new ThreadConnection(creds),
    private capacity = 3,
  ) {
    this.cleanup = setInterval(() => {
      for (const [id, item] of this.connections)
        if (Date.now() - item.touched > 10 * 60000 || Date.now() > item.expires)
          this.disconnect(id);
    }, 30000).unref();
  }
  /** Prevent a connect/forget race from recreating a credential the user just removed. */
  async exclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(userId))
      fail(409, "Another broker operation is in progress.");
    this.busy.add(userId);
    try {
      return await fn();
    } finally {
      this.busy.delete(userId);
    }
  }
  /** Replace only this user's SDK instance; reserve capacity before the slow broker handshake. */
  async connect(userId: string, creds: BreezeCredentials, expires: number) {
    if (this.closed) fail(503, "Broker manager is shutting down.");
    if (expires <= Date.now()) fail(401, "Please sign in again.");
    this.disconnect(userId);
    if (this.connections.size >= this.capacity)
      fail(503, "Broker connection capacity reached. Try again later.");
    const connection = this.factory(creds);
    const pending = { connection, touched: Date.now(), expires, ready: false };
    this.connections.set(userId, pending);
    try {
      await connection.call("connect");
      if (this.closed || this.connections.get(userId) !== pending || expires <= Date.now())
        throw new Error("Broker authentication was revoked.");
      pending.ready = true;
    } catch {
      if (this.connections.get(userId) === pending) this.disconnect(userId);
      else connection.close();
      fail(
        502,
        "ICICI connection failed. Check credentials/session, registered IP and broker availability.",
      );
    }
  }
  /** Touch a live account connection without ever returning another user's connection. */
  get(userId: string) {
    const item = this.connections.get(userId);
    if (!item || !item.ready) return null;
    if (Date.now() > item.expires) {
      this.disconnect(userId);
      return null;
    }
    item.touched = Date.now();
    return item.connection;
  }
  /** Close in-memory broker state; encrypted persistence is explicitly removed by the DELETE route. */
  disconnect(userId: string) {
    this.connections.get(userId)?.connection.close();
    this.connections.delete(userId);
  }
  /** Release every SDK and timer during API shutdown or test teardown. */
  close() {
    this.closed = true;
    clearInterval(this.cleanup);
    for (const id of this.connections.keys()) this.disconnect(id);
  }
}

/** Mount after session/CSRF middleware. Cloud broker operations require enrolled MFA. */
export function registerBrokerRoutes(
  app: Express,
  store: Store,
  vault: ReturnType<typeof credentialVault>,
  manager: BrokerManager,
  requireMfa = false,
) {
  const authenticatedUserId = (req: Request) => req.res!.locals.session.user_id;
  const brokerLimit = rateLimit(20, 60000, authenticatedUserId);
  // Every market operation reserves a conservative allowance that survives server restarts.
  app.use("/api/brokers/icici", async (req, res, next) => {
    if (req.method !== "POST") return next();
    const userId = authenticatedUserId(req);
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      if (requireMfa) {
        const [security] = await query<{ enabled: boolean }>(
          "SELECT enabled FROM user_security WHERE user_id=$1",
          [userId],
        );
        if (!security?.enabled)
          fail(
            403,
            "Enable authenticator MFA in Account & security before connecting a broker on this server.",
          );
      }
      // IST day boundary, with headroom below Breeze's published account-wide allowance.
      const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      const [usage] = await query<{ usage_day: string; request_count: number }>(
        "SELECT * FROM broker_usage WHERE user_id=$1",
        [userId],
      );
      const count = usage?.usage_day === day ? usage.request_count : 0;
      if (count >= 4000)
        fail(
          429,
          "Daily market-data request allowance reached. Try again tomorrow.",
        );
      await query(
        "INSERT INTO broker_usage VALUES ($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET usage_day=$2,request_count=$3",
        [userId, day, count + 2],
      );
    });
    next();
  });
  /** Fetch one encrypted record by authenticated owner; decrypt only for an explicit reconnect. */
  async function loadEncryptedBrokerCredentials(userId: string) {
    const [row] = await store.transaction((query) =>
      query<{ ciphertext: string; updated_at: string }>(
        "SELECT ciphertext,updated_at FROM broker_credentials WHERE user_id=$1",
        [userId],
      ),
    );
    return row;
  }
  /** Recheck after slow I/O under the same account lock as session revocation. */
  async function requireCurrentSession(query: import("./database.js").Query, session: import("./types.js").LoginSession) {
    await lockWorkspaceSettings(query, store, session.user_id);
    const [current] = await query(
      "SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires>$3",
      [session.token_hash, session.user_id, Date.now() / 1000],
    );
    if (!current) fail(401, "Please sign in again.");
    if (requireMfa) {
      const [security] = await query<{ enabled: boolean }>("SELECT enabled FROM user_security WHERE user_id=$1", [session.user_id]);
      if (!security?.enabled) fail(403, "Enable MFA before connecting a broker.");
    }
  }
  app.get("/api/brokers/icici", async (req, res) => {
    const userId = authenticatedUserId(req),
      row = await loadEncryptedBrokerCredentials(userId),
      current = manager.get(userId)?.snapshot();
    res.json({
      saved: Boolean(row),
      updated_at: row?.updated_at || null,
      state: current?.state || "disconnected",
      live_orders_enabled: false,
    });
  });
  app.post("/api/brokers/icici/connect", brokerLimit, async (req, res) => {
    const input = credentials.parse(req.body),
      userId = authenticatedUserId(req);
    await manager.exclusive(userId, async () => {
      await store.transaction(query => requireCurrentSession(query, res.locals.session));
      await manager.connect(userId, input, res.locals.session.expires * 1000);
      try {
        await store.transaction(async (query) => {
          await requireCurrentSession(query, res.locals.session);
          await query(
            "INSERT INTO broker_credentials VALUES ($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET ciphertext=$2,updated_at=$3",
            [userId, vault.seal(userId, input), now()],
          );
          await audit(
            query,
            "ICICI Direct connected for read-only market data.",
            userId,
          );
        });
      } catch (error) {
        manager.disconnect(userId);
        throw error;
      }
    });
    res.json({ connected: true, live_orders_enabled: false });
  });
  app.post("/api/brokers/icici/reconnect", brokerLimit, async (req, res) => {
    const userId = authenticatedUserId(req);
    await manager.exclusive(userId, async () => {
      await store.transaction(query => requireCurrentSession(query, res.locals.session));
      const row = await loadEncryptedBrokerCredentials(userId);
      if (!row) fail(409, "Add your ICICI credentials first.");
      let saved: BreezeCredentials;
      try {
        saved = credentials.parse(vault.open(userId, row.ciphertext));
      } catch {
        return fail(409, "Saved credentials unavailable. Enter them again.");
      }
      await manager.connect(userId, saved, res.locals.session.expires * 1000);
      try {
        await store.transaction(query => requireCurrentSession(query, res.locals.session));
      } catch (error) {
        manager.disconnect(userId);
        throw error;
      }
    });
    res.json({ connected: true });
  });
  app.delete("/api/brokers/icici", async (req, res) => {
    const userId = authenticatedUserId(req);
    await manager.exclusive(userId, async () => {
      manager.disconnect(userId);
      await store.transaction(async (query) => {
        await query("DELETE FROM broker_credentials WHERE user_id=$1", [
          userId,
        ]);
        await audit(
          query,
          "ICICI connection and saved credentials removed.",
          userId,
        );
      });
    });
    res.json({ ok: true });
  });
  app.post("/api/brokers/icici/historical", brokerLimit, async (req, res) => {
    const params = historical.parse(req.body);
    validateInstrument(params);
    const range = Date.parse(params.toDate) - Date.parse(params.fromDate);
    if (range <= 0 || range > (params.interval === "1day" ? 365 : 1) * 86400000)
      fail(
        422,
        "Use up to one day for intraday data, or 365 days for daily candles.",
      );
    if (Date.parse(params.toDate) > Date.now())
      fail(422, "Historical end time must not be in the future.");
    const connection =
      manager.get(authenticatedUserId(req)) ||
      fail(409, "Connect or reconnect ICICI first.");
    try {
      res.json({
        source: "icici-breeze",
        candles: await connection.call("historical", {
          ...params,
          ...(params.expiryDate
            ? { expiryDate: `${params.expiryDate}T00:00:00.000Z` }
            : {}),
        }),
      });
    } catch {
      fail(
        502,
        "Historical request failed. Check instrument/session and reconnect if needed.",
      );
    }
  });
  app.post("/api/brokers/icici/subscribe", brokerLimit, async (req, res) => {
    const params = instrument.parse(req.body);
    validateInstrument(params);
    if (params.expiryDate) {
      // Socket token lookup uses DD-MMM-YYYY; historical-v2 uses ISO expiry strings instead.
      const date = new Date(`${params.expiryDate}T00:00:00Z`);
      params.expiryDate = `${String(date.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]}-${date.getUTCFullYear()}`;
    }
    const connection =
      manager.get(authenticatedUserId(req)) ||
      fail(409, "Connect or reconnect ICICI first.");
    try {
      await connection.call("subscribe", {
        ...params,
        getExchangeQuotes: true,
        getMarketDepth: false,
      });
      res.json({ subscribed: true });
    } catch {
      fail(
        502,
        "Subscription failed. Check instrument/session and reconnect if needed.",
      );
    }
  });
  app.get("/api/brokers/icici/live", (req, res) => {
    const current = manager.get(authenticatedUserId(req))?.snapshot();
    res.json(
      current || { state: "disconnected", tick: null, receivedAt: null },
    );
  });
}
