/**
 * Owner/session-bound Zerodha authorization and its private Kite SDK adapter.
 * One-use login state and per-user SDK instances keep credentials in server memory.
 * Connection establishes authentication only; this module never dispatches orders.
 */
import type { Express } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { KiteConnect, type Connect } from "kiteconnect";
import { fail, rateLimit } from "./security.js";
import {
  normalizeZerodhaAvailableFunds,
  normalizeZerodhaPortfolioRows,
} from "./broker-portfolio-normalizer.js";
import type { BrokerSessionStore } from "./broker-session-store.js";
import type { BrokerAppCredentialStore } from "./broker-app-credential-store.js";

type Client = Pick<
  Connect,
  | "getLoginURL"
  | "generateSession"
  | "setAccessToken"
  | "getProfile"
  | "getMargins"
  | "getHoldings"
  | "getPositions"
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
    return {
      account: saved.account,
      saved: () => saved,
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
  connected: (userId: string, accountBinding: string) => Promise<void>;
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
          await events?.connected(
            owner.user_id,
            `zerodha:${createHash("sha256").update(client.account.user_id.trim().toUpperCase()).digest("hex")}`,
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
