/**
 * Owner/session-bound Zerodha authorization and its private Kite SDK adapter.
 * One-use login state and per-user SDK instances keep credentials in server memory.
 * Connection never authorizes trading. Only the live manager receives the fenced execution capability.
 */
import type { Express } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { KiteConnect, type Connect } from "kiteconnect";
import { fail, rateLimit } from "./security.js";
import {
  normalizeZerodhaAvailableFunds,
  normalizeZerodhaFunds,
  normalizeZerodhaPortfolioRows,
} from "./broker-portfolio-normalizer.js";
import type { BrokerSessionStore } from "./broker-session-store.js";
import type { BrokerAppCredentialStore } from "./broker-app-credential-store.js";
import type { PortfolioBrokerReader } from "./portfolio-service.js";
import { tradingDay } from "./market-contracts.js";

type Client = Pick<
  Connect,
  | "getLoginURL"
  | "generateSession"
  | "setAccessToken"
  | "getProfile"
  | "getMargins"
  | "getHoldings"
  | "getPositions"
  | "getInstruments"
  | "getQuote"
  | "invalidateAccessToken"
>;
const credential = z.string().trim().min(1).max(256);
const appCredentials = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    apiSecret: z.string().trim().min(16).max(128),
  })
  .strict();
const profile = z.object({
  user_id: z.string().min(1).max(64),
  user_name: z.string().max(160),
});

/** Factory never shares authenticated SDK instances between users or exposes raw SDK responses. */
export function createZerodhaSdk(
  credentials: z.infer<typeof appCredentials>,
  factory: (key: string) => Client = (key) =>
    new KiteConnect({ api_key: key, debug: false, timeout: 10000 }),
) {
  const { apiKey: key, apiSecret: secret } = appCredentials.parse(credentials);
  function restore(value: unknown) {
    const saved = z
      .object({ accessToken: credential, account: profile })
      .parse(value);
    const client = factory(key);
    client.setAccessToken(saved.accessToken);
    // Session-local master cache: no credentials or quotes are shared across owners.
    let optionMaster: Awaited<ReturnType<Client["getInstruments"]>> = [];
    let masterDay = "";
    return {
      async optionSnapshot(
        input: {
          query: string;
          underlying?: string;
          expiryDate?: string;
          offset: number;
        },
        reserve: () => Promise<void>,
      ) {
        const today = tradingDay(Date.now());
        if (masterDay !== today) {
          await reserve();
          optionMaster = await client.getInstruments("NFO");
          masterDay = today;
        }
        const expiryOf = (value: unknown) =>
          value instanceof Date
            ? tradingDay(value.getTime())
            : String(value).slice(0, 10);
        const available = optionMaster.filter(
          (row) =>
            (row.instrument_type === "CE" || row.instrument_type === "PE") &&
            expiryOf(row.expiry) >= today,
        );
        const underlyings = [...new Set(available.map((row) => row.name))]
          .filter((name) => name.includes(input.query))
          .sort();
        const contracts = available.filter(
          (row) => row.name === input.underlying,
        );
        const expiries = [
          ...new Set(contracts.map((row) => expiryOf(row.expiry))),
        ]
          .sort()
          .slice(0, 2);
        if (input.expiryDate && !expiries.includes(input.expiryDate)) {
          fail(422, "Choose the current or next available expiry.");
        }
        const rows = contracts
          .filter((row) => expiryOf(row.expiry) === input.expiryDate)
          .sort(
            (a, b) =>
              a.strike - b.strike ||
              a.instrument_type.localeCompare(b.instrument_type),
          );
        const page = rows.slice(input.offset, input.offset + 50);
        const spotSymbols: Record<string, string> = {
          NIFTY: "NIFTY 50",
          BANKNIFTY: "NIFTY BANK",
          FINNIFTY: "NIFTY FIN SERVICE",
        };
        const spotKey = `NSE:${spotSymbols[input.underlying ?? ""] ?? input.underlying}`;
        const keys = page.map((row) => `NFO:${row.tradingsymbol}`);
        const observedAt = Date.now();
        let quotes: Awaited<ReturnType<Client["getQuote"]>> = {};
        let quoteWarning = "";
        if (page.length) {
          await reserve();
          try {
            quotes = await client.getQuote([...keys, spotKey]);
          } catch (error) {
            // A denied quote entitlement is not an empty instrument directory.
            // Preserve exact contracts, redact SDK payloads, and never invent premiums.
            const kind = (error as { error_type?: string })?.error_type;
            quoteWarning =
              kind === "PermissionException"
                ? "Zerodha denied quote access. Check this Kite API app's market-data permissions/subscription. Contracts are available; premiums and spot are unavailable."
                : kind === "TokenException"
                  ? "Zerodha rejected the broker session. Reconnect Zerodha, then refresh quotes."
                  : "Zerodha quotes are unavailable. Listed contracts are shown without prices; refresh quotes to retry.";
          }
        }
        const positive = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value > 0
            ? value
            : null;
        return {
          underlyings,
          expiries,
          total: rows.length,
          nextOffset:
            input.offset + 50 < rows.length ? input.offset + 50 : null,
          items: page.map((row, index) => ({
            instrument: String(row.instrument_token),
            masterToken: String(row.instrument_token),
            symbol: row.name,
            name: row.tradingsymbol,
            market: "options",
            lotSize: row.lot_size,
            option: {
              expiryDate: expiryOf(row.expiry),
              right: row.instrument_type === "CE" ? "call" : "put",
              strikePrice: row.strike,
              lotSize: row.lot_size,
            },
            price: positive(quotes[keys[index]!]?.last_price),
            bid: null,
            ask: null,
            openInterest: quotes[keys[index]!]?.oi ?? null,
            stale: true,
          })),
          underlyingPrice: positive(quotes[spotKey]?.last_price),
          source: "zerodha",
          dataMode: "historical" as const,
          receivedAt: observedAt,
          observedAt,
          warning:
            quoteWarning ||
            "Broker quote snapshot, not a live stream. Exchange trade freshness is unverified; refresh to request latest available quotes.",
          quotesUnavailable: Boolean(quoteWarning),
        };
      },
      account: saved.account,
      saved: () => saved,
      /** Narrow server-only wire capability: abortable requests, no retries and no raw SDK errors. */
      async executionRequest(
        path: string,
        method: "GET" | "POST" | "DELETE",
        body: Record<string, string> | undefined,
        signal: AbortSignal,
      ) {
        const allowed =
          method === "GET"
            ? [
                "/orders",
                "/portfolio/positions",
                "/portfolio/holdings",
                "/user/margins/equity",
              ].includes(path) ||
              /^\/quote\?i=(NSE|NFO)%3A[A-Za-z0-9%_.&-]+$/.test(path)
            : method === "POST"
              ? path === "/orders/regular"
              : /^\/orders\/regular\/\d{1,30}$/.test(path);
        if (!allowed || (method === "POST") !== Boolean(body)) {
          throw new Error("Unsupported execution request");
        }
        try {
          const response = await fetch(`https://api.kite.trade${path}`, {
            method,
            signal,
            redirect: "error",
            headers: {
              "X-Kite-Version": "3",
              Authorization: `token ${key}:${saved.accessToken}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            ...(body ? { body: new URLSearchParams(body).toString() } : {}),
          });
          if (!response.ok || !response.body) {
            throw new Error();
          }
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) {
                break;
              }
              size += part.value.length;
              if (size > 8 * 1024 * 1024) {
                throw new Error();
              }
              chunks.push(part.value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (envelope?.status !== "success" || envelope.data === undefined) {
            throw new Error();
          }
          return envelope.data as unknown;
        } catch {
          // Even an HTTP error is ambiguous for writes. The OMS reconciles; it never retries.
          throw new Error(
            "Zerodha execution response unavailable or unconfirmed. Reconcile before retrying any action.",
          );
        }
      },
      executionInstruments: (market: "cash" | "options") =>
        client.getInstruments(market === "cash" ? "NSE" : "NFO"),
      async revoke() {
        try {
          await client.invalidateAccessToken(saved.accessToken);
          return true;
        } catch {
          return false;
        }
      },
      async verify() {
        try {
          const current = profile.parse(await client.getProfile());
          if (current.user_id !== saved.account.user_id) {
            throw new Error();
          }
          return current;
        } catch {
          throw new Error(
            "Zerodha session verification unavailable. Try again or authorize your account.",
          );
        }
      },
      async portfolio(kind: "positions" | "holdings") {
        try {
          return normalizeZerodhaPortfolioRows(
            kind,
            kind === "holdings"
              ? await client.getHoldings()
              : (await client.getPositions()).net,
          );
        } catch {
          throw new Error(`Zerodha ${kind} are unavailable.`);
        }
      },
      async availableFunds() {
        try {
          return normalizeZerodhaAvailableFunds(await client.getMargins());
        } catch {
          throw new Error("Zerodha margin is unavailable.");
        }
      },
      /** Preserve the full normalized margin breakdown for durable portfolio snapshots. */
      async funds() {
        try {
          return normalizeZerodhaFunds(await client.getMargins());
        } catch {
          throw new Error("Zerodha margin is unavailable.");
        }
      },
    };
  }
  return {
    restore,
    loginUrl(state: string) {
      z.string()
        .regex(/^[A-Za-z0-9_-]{43,128}$/)
        .parse(state);
      const url = new URL(factory(key).getLoginURL());
      if (
        url.protocol !== "https:" ||
        !["kite.zerodha.com", "kite.trade"].includes(url.hostname)
      ) {
        throw new Error("Unexpected Kite login destination.");
      }
      url.searchParams.set(
        "redirect_params",
        new URLSearchParams({ state }).toString(),
      );
      return url.toString();
    },
    async exchange(requestToken: string) {
      credential.parse(requestToken);
      const client = factory(key);
      try {
        const session = await client.generateSession(requestToken, secret);
        const account = profile.parse(session);
        return restore({ account, accessToken: session.access_token });
      } catch {
        // SDK errors can include authorization headers; never propagate raw errors.
        throw new Error(
          "Zerodha login failed. Start a new login from Broker connections.",
        );
      }
    },
  };
}

type Sdk = ReturnType<typeof createZerodhaSdk>;
type Owner = { user_id: string; token_hash: string; expires: number };
type Pending = { state: string; deadline: number; owner: Owner; sdk: Sdk };
type Connection = {
  client: Awaited<ReturnType<Sdk["exchange"]>>;
  deadline: number;
  owner: Owner;
};
export type ZerodhaConnectionEvents = {
  connected: (
    userId: string,
    sessionHash: string,
    accountBinding: string,
    reader: PortfolioBrokerReader,
  ) => Promise<void>;
  disconnected: (userId: string) => Promise<void>;
};

/** Broker sessions persist only through the encrypted session store, never frontend state.
 * Each application login owns its broker session; broker passwords are never retained. */
export function createZerodhaConnection(
  env: NodeJS.ProcessEnv,
  injected?: Sdk,
  events?: ZerodhaConnectionEvents,
  savedSessions?: BrokerSessionStore,
  savedAppCredentials?: BrokerAppCredentialStore,
) {
  const environmentSdk =
    injected ??
    (env.ZERODHA_API_KEY && env.ZERODHA_API_SECRET
      ? createZerodhaSdk({
          apiKey: env.ZERODHA_API_KEY,
          apiSecret: env.ZERODHA_API_SECRET,
        })
      : null);
  const callbackUrl = new URL(
    "/brokers/zerodha/callback",
    env.APP_ORIGIN || "http://localhost:3000",
  ).href;
  const pending = new Map<string, Pending>();
  const connections = new Map<string, Connection>();
  function prune() {
    for (const [key, value] of pending) {
      if (value.deadline <= Date.now()) {
        pending.delete(key);
      }
    }
    for (const [key, value] of connections) {
      if (value.deadline <= Date.now()) {
        connections.delete(key);
      }
    }
  }
  const timer = setInterval(prune, 60000);
  timer.unref();
  /** Resolve owner-specific encrypted credentials before the deployment fallback. */
  async function sdkFor(userId: string) {
    if (injected) {
      return injected;
    }
    const saved = await savedAppCredentials?.load(userId, "zerodha");
    return saved
      ? createZerodhaSdk(appCredentials.parse(saved))
      : environmentSdk;
  }
  async function status(owner: Owner, resolvedSdk?: Sdk | null) {
    prune();
    const connected = connections.get(owner.token_hash);
    return {
      configured: Boolean(
        resolvedSdk === undefined ? await sdkFor(owner.user_id) : resolvedSdk,
      ),
      connected: Boolean(connected),
      expiresAt: connected?.deadline ?? null,
      callbackUrl,
      account: connected?.client.account ?? null,
    };
  }
  function disconnect(userId: string) {
    const revocations: Promise<boolean>[] = [];
    for (const [key, value] of pending) {
      if (value.owner.user_id === userId) {
        pending.delete(key);
      }
    }
    for (const [key, value] of connections) {
      if (value.owner.user_id === userId) {
        connections.delete(key);
        revocations.push(value.client.revoke());
      }
    }
    void events?.disconnected(userId).catch(() => {});
    return Promise.all(revocations);
  }
  /** Runtime connectivity is session-bound; durable registry state alone never proves access. */
  function isConnected(userId: string, sessionHash: string) {
    prune();
    const connection = connections.get(sessionHash);
    return Boolean(connection && connection.owner.user_id === userId);
  }
  /** Expose only normalized account reads to the broker-neutral portfolio service. */
  function portfolioReader(
    userId: string,
    sessionHash: string,
  ): PortfolioBrokerReader | null {
    prune();
    const connection = connections.get(sessionHash);
    if (!connection || connection.owner.user_id !== userId) {
      return null;
    }
    const accountBinding = `zerodha:${createHash("sha256").update(connection.client.account.user_id.trim().toUpperCase()).digest("hex")}`;
    return {
      provider: "zerodha",
      accountBinding,
      loadFunds: () => connection.client.funds(),
      loadHoldings: () => connection.client.portfolio("holdings"),
      loadPositions: () => connection.client.portfolio("positions"),
    };
  }
  /** Return normalized readers for currently valid sessions without exposing SDK clients. */
  function activePortfolioReaders() {
    prune();
    return [...connections.values()].flatMap((connection) => {
      const reader = portfolioReader(
        connection.owner.user_id,
        connection.owner.token_hash,
      );
      return reader
        ? [
            {
              userId: connection.owner.user_id,
              sessionHash: connection.owner.token_hash,
              reader,
            },
          ]
        : [];
    });
  }
  return {
    async restore(owner: Owner) {
      const sdk = await sdkFor(owner.user_id);
      if (
        !sdk ||
        connections.has(owner.token_hash) ||
        pending.has(owner.token_hash)
      ) {
        return;
      }
      const marker = {
        owner,
        state: "restoring",
        deadline: owner.expires * 1000,
        sdk,
      };
      pending.set(owner.token_hash, marker);
      try {
        const saved = await savedSessions?.load(owner, "zerodha");
        if (!saved) {
          return;
        }
        const client = sdk.restore(saved.value);
        await client.verify();
        if (
          pending.get(owner.token_hash) === marker &&
          saved.expires > Date.now()
        ) {
          connections.set(owner.token_hash, {
            owner,
            client,
            deadline: Math.min(saved.expires, owner.expires * 1000),
          });
        }
      } finally {
        if (pending.get(owner.token_hash) === marker) {
          pending.delete(owner.token_hash);
        }
      }
    },
    disconnect,
    isConnected,
    /** Capture the exact owner/session. Reconnects invalidate reads and writes, including late responses. */
    executionSession(userId: string, sessionHash: string) {
      if (!isConnected(userId, sessionHash)) {
        fail(409, "Reconnect the active Zerodha broker first.");
      }
      const connection = connections.get(sessionHash)!;
      const isCurrent = () =>
        connections.get(sessionHash) === connection &&
        isConnected(userId, sessionHash);
      return {
        accountBinding: `zerodha:${createHash("sha256").update(connection.client.account.user_id.trim().toUpperCase()).digest("hex")}`,
        expiresAt: connection.deadline,
        isCurrent,
        async request(
          path: string,
          method: "GET" | "POST" | "DELETE",
          body: Record<string, string> | undefined,
          signal: AbortSignal,
        ) {
          if (!isCurrent() || signal.aborted) {
            throw new Error("Zerodha execution session changed");
          }
          const result = await connection.client.executionRequest(
            path,
            method,
            body,
            signal,
          );
          if (!isCurrent() || signal.aborted) {
            throw new Error("Zerodha execution session changed");
          }
          return result;
        },
        async instruments(market: "cash" | "options") {
          if (!isCurrent()) {
            throw new Error("Zerodha execution session changed");
          }
          const result = await connection.client.executionInstruments(market);
          if (!isCurrent()) {
            throw new Error("Zerodha execution session changed");
          }
          return result;
        },
      };
    },
    async optionSnapshot(
      userId: string,
      sessionHash: string,
      input: {
        query: string;
        underlying?: string;
        expiryDate?: string;
        offset: number;
      },
      reserve: () => Promise<void>,
    ) {
      prune();
      const connection = connections.get(sessionHash);
      if (!connection || connection.owner.user_id !== userId) {
        return fail(
          409,
          "Connect the active Zerodha session to request option quotes.",
        );
      }
      const result = await connection.client.optionSnapshot(input, reserve);
      if (
        !isConnected(userId, sessionHash) ||
        connections.get(sessionHash) !== connection
      ) {
        return fail(409, "Broker session changed during quote loading.");
      }
      return result;
    },
    portfolioReader,
    activePortfolioReaders,
    close() {
      clearInterval(timer);
      pending.clear();
      connections.clear();
    },
    register(app: Express) {
      app.use(
        "/api/brokers/zerodha",
        rateLimit(20, 60000, (req) => req.res!.locals.session.user_id),
      );
      app.get("/api/brokers/zerodha", async (_req, res) => {
        res.json({
          ...(await status(res.locals.session)),
          csrf: res.locals.session.csrf,
        });
      });
      app.put("/api/brokers/zerodha/configuration", async (req, res) => {
        if (!savedAppCredentials) {
          return fail(
            409,
            "This server accepts Zerodha credentials only from its environment.",
          );
        }
        const input = appCredentials.parse(req.body);
        const owner: Owner = res.locals.session;
        await disconnect(owner.user_id);
        await savedSessions?.remove(owner.user_id, "zerodha");
        await savedAppCredentials.save(owner.user_id, "zerodha", input);
        res.json(await status(owner, createZerodhaSdk(input)));
      });
      app.post("/api/brokers/zerodha/login", async (_req, res) => {
        const owner: Owner = res.locals.session;
        const sdk = await sdkFor(owner.user_id);
        if (!sdk) {
          return fail(
            409,
            "Save your Zerodha API key and secret in Set up Zerodha first.",
          );
        }
        prune();
        if (pending.size >= 1000) {
          return fail(503, "Login capacity reached. Try again later.");
        }
        connections.delete(owner.token_hash);
        await savedSessions?.remove(owner.user_id, "zerodha");
        const state = randomBytes(32).toString("base64url");
        pending.set(owner.token_hash, {
          owner,
          state,
          deadline: Math.min(Date.now() + 300000, owner.expires * 1000),
          sdk,
        });
        res.json({ url: sdk.loginUrl(state) });
      });
      app.post("/api/brokers/zerodha/callback", async (req, res) => {
        const input = z
          .object({
            state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            request_token: z.string().min(1).max(256),
          })
          .strict()
          .parse(req.body);
        const owner: Owner = res.locals.session;
        prune();
        const attempt = pending.get(owner.token_hash);
        if (!attempt || attempt.state !== input.state) {
          return fail(
            409,
            "This Zerodha login has expired or belongs to another session. Start again.",
          );
        }
        // Consume before awaiting: duplicate callbacks cannot exchange the same token twice.
        pending.delete(owner.token_hash);
        const marker = { ...attempt, state: "exchanging" };
        pending.set(owner.token_hash, marker);
        try {
          const client = await attempt.sdk.exchange(input.request_token);
          await client.verify();
          if (
            pending.get(owner.token_hash) !== marker ||
            marker.deadline <= Date.now()
          ) {
            return fail(409, "Login cancelled or expired. Start again.");
          }
          if (connections.size >= 1000 && !connections.has(owner.token_hash)) {
            return fail(503, "Connection capacity reached.");
          }
          // Next 06:00 IST is 00:30 UTC. Never retain beyond the application session.
          const nextExpiry = new Date(Date.now());
          nextExpiry.setUTCHours(0, 30, 0, 0);
          if (nextExpiry.getTime() <= Date.now()) {
            nextExpiry.setUTCDate(nextExpiry.getUTCDate() + 1);
          }
          connections.set(owner.token_hash, {
            owner,
            client,
            deadline: Math.min(nextExpiry.getTime(), owner.expires * 1000),
          });
          const reader = portfolioReader(owner.user_id, owner.token_hash);
          if (!reader) {
            throw new Error("Zerodha portfolio session is unavailable.");
          }
          await events?.connected(
            owner.user_id,
            owner.token_hash,
            reader.accountBinding,
            reader,
          );
          if (
            pending.get(owner.token_hash) !== marker ||
            connections.get(owner.token_hash)?.client !== client
          ) {
            return fail(
              409,
              "Authorization changed. Check the current broker connection.",
            );
          }
          await savedSessions?.save(
            owner,
            "zerodha",
            connections.get(owner.token_hash)!.deadline,
            client.saved(),
          );
          res.json(await status(owner));
        } catch (error) {
          if (pending.get(owner.token_hash) === marker) {
            connections.delete(owner.token_hash);
            await savedSessions?.remove(owner.user_id, "zerodha");
          }
          // Preserve our deliberate public cancellation/capacity errors; SDK errors
          // remain sanitized and must never expose provider credentials or payloads.
          if (
            error instanceof Error &&
            "detail" in error &&
            "status" in error &&
            (error.status === 409 || error.status === 503)
          ) {
            throw error;
          }
          return fail(
            502,
            "Zerodha login could not be completed. Start a new login; do not retry this callback.",
          );
        } finally {
          if (pending.get(owner.token_hash) === marker) {
            pending.delete(owner.token_hash);
          }
        }
      });
      app.post("/api/brokers/zerodha/verify", async (_req, res) => {
        const owner: Owner = res.locals.session;
        prune();
        const current = connections.get(owner.token_hash);
        if (current) {
          try {
            await current.client.verify();
          } catch {
            if (connections.get(owner.token_hash) === current) {
              connections.delete(owner.token_hash);
            }
            return fail(
              409,
              "Zerodha verification failed. Reconnect your account.",
            );
          }
        }
        res.json(await status(owner));
      });
      app.post("/api/brokers/zerodha/disconnect", async (_req, res) => {
        const current = connections.get(res.locals.session.token_hash);
        pending.delete(res.locals.session.token_hash);
        connections.delete(res.locals.session.token_hash);
        await savedSessions?.remove(res.locals.session.user_id, "zerodha");
        await events?.disconnected(res.locals.session.user_id);
        const revoked = current ? await current.client.revoke() : true;
        res.json({
          ...(await status(res.locals.session)),
          warning: revoked
            ? null
            : "Disconnected locally. Broker revocation could not be confirmed; revoke access in Kite if needed.",
        });
      });
      app.post(
        "/api/brokers/zerodha/overview",
        rateLimit(12, 60000, (req) => req.res!.locals.session.user_id),
        async (_req, res) => {
          const owner: Owner = res.locals.session;
          prune();
          const current = connections.get(owner.token_hash);
          if (!current || current.owner.user_id !== owner.user_id) {
            return fail(409, "Connect Zerodha before loading its overview.");
          }
          const result: Record<string, unknown> = {
            source: "zerodha",
            readOnly: true,
            observedAt: Date.now(),
          };
          try {
            const available = await current.client.availableFunds();
            result.limits = {
              rows: available === null ? null : [{ available }],
              error:
                available === null
                  ? "Zerodha available margin is unavailable."
                  : null,
            };
          } catch {
            result.limits = {
              rows: null,
              error: "Zerodha available margin is unavailable.",
            };
          }
          try {
            result.positions = {
              rows: await current.client.portfolio("positions"),
              error: null,
            };
          } catch {
            result.positions = {
              rows: null,
              error:
                "Zerodha positions are unavailable. Verify your broker session; this is not an empty account.",
            };
          }
          try {
            result.holdings = {
              rows: await current.client.portfolio("holdings"),
              error: null,
            };
          } catch {
            result.holdings = {
              rows: null,
              error:
                "Zerodha holdings are unavailable. Verify your broker session; this is not an empty demat account.",
            };
          }
          res.json(result);
        },
      );
      app.post(
        "/api/portfolio/zerodha/refresh",
        rateLimit(12, 60000, (req) => req.res!.locals.session.user_id),
        async (_req, res) => {
          const owner: Owner = res.locals.session;
          prune();
          const current = connections.get(owner.token_hash);
          if (!current || current.owner.user_id !== owner.user_id) {
            return fail(409, "Connect Zerodha before loading its portfolio.");
          }
          const result: Record<string, unknown> = {
            broker: "zerodha",
            readOnly: true,
            observedAt: Date.now(),
          };
          for (const kind of ["positions", "holdings"] as const) {
            try {
              result[kind] = {
                rows: await current.client.portfolio(kind),
                error: null,
              };
            } catch {
              result[kind] = {
                rows: null,
                error: `Zerodha ${kind} unavailable. Verify your broker session; this is not an empty portfolio.`,
              };
            }
          }
          res.json(result);
        },
      );
    },
  };
}
