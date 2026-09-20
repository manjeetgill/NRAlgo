/**
 * Owner-bound ICICI Direct Breeze connection and broker-neutral portfolio adapter.
 *
 * Breeze currently documents NSE/NFO support only. BSE and MCX are deliberately
 * rejected instead of being presented as empty accounts. App credentials and the
 * short-lived session are encrypted server-side and never returned to the browser.
 */
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { Express } from "express";
import { z } from "zod";
import type { BrokerAppCredentialStore } from "./broker-app-credential-store.js";
import type { BrokerSessionStore } from "./broker-session-store.js";
import {
  normalizeIciciFunds,
  normalizeIciciPortfolioRows,
} from "./broker-portfolio-normalizer.js";
import type { PortfolioBrokerReader } from "./portfolio-service.js";
import { fail, rateLimit } from "./security.js";

const credentialsSchema = z
  .object({
    appKey: z.string().trim().min(8).max(128),
    secretKey: z.string().trim().min(8).max(256),
  })
  .strict();
const connectSchema = credentialsSchema.extend({
  sessionKey: z.string().trim().min(1).max(512),
});
const customerSchema = z.object({
  idirect_userid: z.string().trim().min(1).max(80),
  idirect_user_name: z.string().trim().max(160).default("ICICI Direct"),
  session_token: z.string().trim().min(1).max(2048),
});
type Owner = { user_id: string; token_hash: string; expires: number };
type Account = z.infer<typeof customerSchema>;
type Connection = {
  owner: Owner;
  account: Account;
  credentials: z.infer<typeof credentialsSchema>;
  deadline: number;
};
export type IciciConnectionEvents = {
  connected: (
    userId: string,
    sessionHash: string,
    accountBinding: string,
    reader: PortfolioBrokerReader,
  ) => Promise<void>;
  disconnected: (userId: string) => Promise<void>;
};

/** Stable JSON is required because the exact payload participates in Breeze's checksum. */
function payload(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

type BreezeTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number; text: string }>;

/** Send ICICI's documented GET-with-JSON-body request with strict host, timeout and size limits. */
const breezeTransport: BreezeTransport = (rawUrl, body, headers) =>
  new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.icicidirect.com" ||
      !url.pathname.startsWith("/breezeapi/api/v1/")
    ) {
      reject(new Error("Unexpected ICICI Direct API destination."));
      return;
    }
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(body)),
        },
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            request.destroy(new Error("ICICI Direct response is too large."));
          } else {
            chunks.push(chunk);
          }
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("ICICI Direct request timed out.")),
    );
    request.on("error", reject);
    request.end(body);
  });

/** Read one bounded Breeze response and redact all provider error bodies. */
function readEnvelope(response: { status: number; text: string }) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error("ICICI Direct API request failed.");
  }
  if (response.text.length > 8 * 1024 * 1024) {
    throw new Error("ICICI Direct response is too large.");
  }
  const envelope = z
    .object({
      Success: z.unknown().nullable(),
      Status: z.number(),
      Error: z.unknown().nullable(),
    })
    .passthrough()
    .parse(JSON.parse(response.text));
  if (envelope.Status !== 200 || envelope.Error || envelope.Success === null) {
    throw new Error("ICICI Direct rejected the request.");
  }
  return envelope.Success;
}

/** ICICI Breeze portfolio connection; connection alone never enables live orders. */
export function createIciciConnection(
  events?: IciciConnectionEvents,
  savedSessions?: BrokerSessionStore,
  savedCredentials?: BrokerAppCredentialStore,
  transport: BreezeTransport = breezeTransport,
) {
  const connections = new Map<string, Connection>();
  // Markers fence network replies; per-owner queues order encrypted writes and registry callbacks.
  // Disconnect removes access immediately, then waits for older writes before deleting them.
  const pending = new Map<string, { owner: Owner }>();
  const queues = new Map<string, Promise<void>>();
  let closed = false;
  function serialize<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const result = (queues.get(userId) ?? Promise.resolve()).then(action);
    const settled = result.then(
      () => {},
      () => {},
    );
    queues.set(userId, settled);
    void settled.then(() => {
      if (queues.get(userId) === settled) {
        queues.delete(userId);
      }
    });
    return result;
  }
  function invalidatePending(userId: string) {
    for (const [key, marker] of pending) {
      if (marker.owner.user_id === userId) {
        pending.delete(key);
      }
    }
  }
  function clearConnections(userId: string) {
    for (const [key, connection] of connections) {
      if (connection.owner.user_id === userId) {
        connections.delete(key);
      }
    }
  }
  function assertPending(marker: { owner: Owner }) {
    if (
      closed ||
      pending.get(marker.owner.token_hash) !== marker ||
      marker.owner.expires * 1000 <= Date.now()
    ) {
      fail(
        409,
        "ICICI Direct connection changed or expired. Please reconnect.",
      );
    }
  }
  const prune = () => {
    for (const [key, connection] of connections) {
      if (connection.deadline <= Date.now()) {
        connections.delete(key);
      }
    }
  };
  const timer = setInterval(prune, 60_000);
  timer.unref();

  /** Exchange the daily API session key for Breeze's authenticated session token. */
  async function authenticate(input: z.infer<typeof connectSchema>) {
    // The daily login key belongs to connectSchema, not the persisted app credentials.
    const credentials = credentialsSchema.parse({
      appKey: input.appKey,
      secretKey: input.secretKey,
    });
    try {
      const response = await transport(
        "https://api.icicidirect.com/breezeapi/api/v1/customerdetails",
        payload({ SessionToken: input.sessionKey, AppKey: input.appKey }),
        { "Content-Type": "application/json" },
      );
      return {
        credentials,
        account: customerSchema.parse(readEnvelope(response)),
      };
    } catch {
      fail(
        502,
        "ICICI Direct authentication failed. Check the Breeze keys and daily session key.",
      );
      throw new Error("ICICI Direct authentication unavailable.");
    }
  }

  /** Sign an NSE/NFO request using the exact JSON body sent on the wire. */
  async function request(
    connection: Connection,
    path: "funds" | "portfolioholdings" | "portfoliopositions",
    body: Record<string, unknown>,
    guard = () => {
      if (
        getConnection(connection.owner.user_id, connection.owner.token_hash) !==
        connection
      ) {
        fail(409, "ICICI Direct connection changed. Please reconnect.");
      }
    },
  ) {
    guard();
    if (connection.deadline <= Date.now()) {
      throw new Error("ICICI Direct session expired.");
    }
    const serialized = payload(body);
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const checksum = createHash("sha256")
      .update(timestamp + serialized + connection.credentials.secretKey)
      .digest("hex");
    let result: unknown;
    try {
      const response = await transport(
        `https://api.icicidirect.com/breezeapi/api/v1/${path}`,
        serialized,
        {
          "Content-Type": "application/json",
          "X-Checksum": `token ${checksum}`,
          "X-Timestamp": timestamp,
          "X-AppKey": connection.credentials.appKey,
          "X-SessionToken": connection.account.session_token,
        },
      );
      result = readEnvelope(response);
    } catch {
      fail(
        502,
        "ICICI Direct account verification or read failed. Check the session and try again.",
      );
    }
    // A disconnect/expiry during I/O must also invalidate the response and captured readers.
    guard();
    if (connection.deadline <= Date.now()) {
      fail(409, "ICICI Direct session expired.");
    }
    return result;
  }

  /** Breeze's signed funds GET verifies credentials without placing an order or renewing expiry. */
  async function verify(connection: Connection, marker: { owner: Owner }) {
    const funds = await request(connection, "funds", {}, () =>
      assertPending(marker),
    );
    if (!funds || typeof funds !== "object" || Array.isArray(funds)) {
      fail(
        502,
        "ICICI Direct verification returned an invalid funds response.",
      );
    }
  }

  function getConnection(userId: string, sessionHash: string) {
    prune();
    const connection = connections.get(sessionHash);
    return connection?.owner.user_id === userId ? connection : null;
  }
  function accountBinding(account: Account) {
    return `icici:${createHash("sha256").update(account.idirect_userid.trim().toUpperCase()).digest("hex")}`;
  }
  function portfolioReader(
    userId: string,
    sessionHash: string,
  ): PortfolioBrokerReader | null {
    const connection = getConnection(userId, sessionHash);
    if (!connection) {
      return null;
    }
    const range = () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 370 * 86_400_000).toISOString();
      return {
        from_date: from,
        to_date: to,
        stock_code: "",
        portfolio_type: "",
      };
    };
    return {
      provider: "icici",
      accountBinding: accountBinding(connection.account),
      loadFunds: async () =>
        normalizeIciciFunds(await request(connection, "funds", {})),
      loadHoldings: async () =>
        normalizeIciciPortfolioRows(
          "holdings",
          await request(connection, "portfolioholdings", {
            exchange_code: "NSE",
            ...range(),
          }),
        ),
      loadPositions: async () => {
        const books = await Promise.all(
          ["NSE", "NFO"].map((exchange_code) =>
            request(connection, "portfoliopositions", {
              exchange_code,
              ...range(),
            }),
          ),
        );
        return normalizeIciciPortfolioRows(
          "positions",
          books.flatMap((book) => z.array(z.unknown()).parse(book)),
        );
      },
    };
  }

  return {
    isConnected: (userId: string, sessionHash: string) =>
      Boolean(getConnection(userId, sessionHash)),
    portfolioReader,
    activePortfolioReaders() {
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
    },
    async restore(owner: Owner) {
      if (
        closed ||
        getConnection(owner.user_id, owner.token_hash) ||
        pending.has(owner.token_hash)
      ) {
        return;
      }
      const marker = { owner };
      pending.set(owner.token_hash, marker);
      return serialize(owner.user_id, async () => {
        try {
          assertPending(marker);
          const [saved, credentials] = await Promise.all([
            savedSessions?.load(owner, "icici"),
            savedCredentials?.load(owner.user_id, "icici"),
          ]);
          assertPending(marker);
          if (!saved || !credentials) {
            return;
          }
          const candidate: Connection = {
            owner,
            account: customerSchema.parse(saved.value),
            credentials: credentialsSchema.parse(credentials),
            deadline: Math.min(saved.expires, owner.expires * 1000),
          };
          if (
            !Number.isFinite(candidate.deadline) ||
            candidate.deadline <= Date.now()
          ) {
            return;
          }
          await verify(candidate, marker);
          assertPending(marker);
          connections.set(owner.token_hash, candidate);
        } finally {
          if (pending.get(owner.token_hash) === marker) {
            pending.delete(owner.token_hash);
          }
        }
      });
    },
    async disconnect(userId: string) {
      invalidatePending(userId);
      clearConnections(userId);
      await serialize(userId, async () => {
        await savedSessions?.remove(userId, "icici");
        await events?.disconnected(userId);
      });
    },
    close() {
      closed = true;
      clearInterval(timer);
      pending.clear();
      connections.clear();
    },
    register(app: Express) {
      app.use(
        "/api/brokers/icici",
        rateLimit(20, 60_000, (req) => req.res!.locals.session.user_id),
      );
      app.get("/api/brokers/icici", (_req, res) => {
        const connection = getConnection(
          res.locals.session.user_id,
          res.locals.session.token_hash,
        );
        res.json({
          configured: Boolean(connection),
          connected: Boolean(connection),
          expiresAt: connection?.deadline ?? null,
          account: connection
            ? {
                user_id: connection.account.idirect_userid,
                user_name: connection.account.idirect_user_name,
              }
            : null,
          capabilities: { exchanges: ["NSE", "NFO"], mcx: false },
        });
      });
      app.post("/api/brokers/icici/connect", async (req, res) => {
        const owner: Owner = res.locals.session;
        const input = connectSchema.parse(req.body);
        invalidatePending(owner.user_id);
        const marker = { owner };
        pending.set(owner.token_hash, marker);
        const deadline = await serialize(owner.user_id, async () => {
          let writing = false;
          try {
            assertPending(marker);
            const authenticated = await authenticate(input);
            assertPending(marker);
            // Use India midnight even when the deployment host runs in UTC.
            const midnight =
              (Math.floor((Date.now() + 19_800_000) / 86_400_000) + 1) *
                86_400_000 -
              19_800_000;
            const deadline = Math.min(midnight, owner.expires * 1000);
            const connection: Connection = {
              owner,
              ...authenticated,
              deadline,
            };
            await verify(connection, marker);
            assertPending(marker);
            writing = true;
            await savedCredentials?.save(
              owner.user_id,
              "icici",
              authenticated.credentials,
            );
            assertPending(marker);
            await savedSessions?.save(
              owner,
              "icici",
              deadline,
              authenticated.account,
            );
            assertPending(marker);
            clearConnections(owner.user_id);
            connections.set(owner.token_hash, connection);
            const reader = portfolioReader(owner.user_id, owner.token_hash)!;
            await events?.connected(
              owner.user_id,
              owner.token_hash,
              reader.accountBinding,
              reader,
            );
            assertPending(marker);
            return deadline;
          } catch (error) {
            if (writing) {
              clearConnections(owner.user_id);
              await savedSessions?.remove(owner.user_id, "icici");
              await events?.disconnected(owner.user_id);
            }
            throw error;
          } finally {
            if (pending.get(owner.token_hash) === marker) {
              pending.delete(owner.token_hash);
            }
          }
        });
        res.json({ connected: true, expiresAt: deadline });
      });
      app.post("/api/brokers/icici/disconnect", async (_req, res) => {
        await this.disconnect(res.locals.session.user_id);
        res.json({ connected: false });
      });
      app.post("/api/brokers/icici/overview", async (_req, res) => {
        const reader = portfolioReader(
          res.locals.session.user_id,
          res.locals.session.token_hash,
        );
        if (!reader) {
          fail(409, "Connect ICICI Direct before loading account data.");
          throw new Error("ICICI Direct portfolio session is unavailable.");
        }
        const [funds, positions, holdings] = await Promise.allSettled([
          reader.loadFunds(),
          reader.loadPositions(),
          reader.loadHoldings(),
        ]);
        const section = <T>(result: PromiseSettledResult<T>, label: string) =>
          result.status === "fulfilled"
            ? { rows: result.value, error: null }
            : {
                rows: null,
                error: `${label} unavailable; the account is not assumed empty.`,
              };
        const normalizedFunds = section(funds, "Funds");
        res.json({
          observedAt: Date.now(),
          limits: normalizedFunds.rows
            ? {
                rows: [
                  {
                    available: normalizedFunds.rows.availableMargin,
                    marginUsed: normalizedFunds.rows.usedMargin,
                    collateral: normalizedFunds.rows.collateralValue,
                    unrealizedPnl: normalizedFunds.rows.positionMtm,
                  },
                ],
                error: null,
              }
            : normalizedFunds,
          positions: section(positions, "Positions"),
          holdings: section(holdings, "Holdings"),
        });
      });
    },
  };
}
