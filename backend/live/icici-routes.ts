/** Authenticated ICICI live control plane. Paper routes/worker never import this module.
 * Switching the UI does not authorize orders: a fresh password+MFA confirmation creates a
 * 15-minute, session-bound permission, checked again inside the OMS dispatch transaction.
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Store, type Query, lockWorkspaceSettings } from "../database.js";
import {
  credentialVault,
  equal,
  fail,
  passwordHash,
  rateLimit,
} from "../security.js";
import { verifySecondFactor } from "../mfa.js";
import type { BreezeCredentials } from "../breeze.js";
import { createLiveAccount, LiveExecutionService } from "./execution.js";
import {
  IciciCashAdapter,
  iciciTradingDay,
  type IciciRpcFactory,
} from "./icici-adapter.js";
import type { OrderIntent, RiskLimits } from "./contracts.js";

type Vault = ReturnType<typeof credentialVault>;
interface LiveAccount {
  id: string;
  user_id: string;
  broker_binding: string;
  snapshot: string;
  halted: boolean;
  halt_reason: string;
  limits: string;
  reconciled_at: number;
}
interface Connection {
  adapter: IciciCashAdapter;
  service: LiveExecutionService;
  credentialVersion: string;
}
/** No intentional AMO orders: narrow weekday window, with broker holiday validation. */
export function isCashSubmissionWindow(timestamp = Date.now()) {
  const ist = new Date(timestamp + 19800000),
    minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return (
    ist.getUTCDay() >= 1 &&
    ist.getUTCDay() <= 5 &&
    minutes >= 560 &&
    minutes < 915
  );
}
const armInput = z
  .object({
    password: z.string().max(128),
    token: z.string().min(6).max(32),
    capitalInr: z.number().int().min(100).max(5000),
    confirmation: z.literal("ENABLE LIVE TRADING"),
    staticIpConfirmed: z.literal(true),
  })
  .strict();
/** Fixed low limits for the first real-broker release; users can choose a smaller allocation. */
function limitsForCapital(capitalInr: number): RiskLimits {
  return {
    maxReservedPaise: capitalInr * 100,
    maxGrossExposurePaise: capitalInr * 100,
    maxPositionUnits: 100,
    maxDailyLossPaise: Math.min(capitalInr * 10, 50000),
    maxOrdersPerMinute: 3,
    fundsDriftTolerancePaise: 0,
  };
}

export class IciciLiveManager {
  private connections = new Map<string, Connection>();
  private busy = new Set<string>();
  private timer: NodeJS.Timeout;
  private stopped = false;
  readonly ready: Promise<void>;
  /** One API process owns these live SDK threads. Startup revokes every prior live permission;
   * recovery reconnects only previously configured accounts, halts and requests cancellation.
   */
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly factory?: IciciRpcFactory,
    private readonly tradingWindow: () => boolean = isCashSubmissionWindow,
    private readonly enabled = false,
  ) {
    this.ready = store.transaction(async (query) => {
      await query("UPDATE live_permissions SET armed_until=0");
      await query(
        "UPDATE live_accounts SET halted=TRUE,reconciled_at=0,halt_reason='Server restarted; reconnect and explicitly enable live again' WHERE broker_binding LIKE 'icici:%'",
      );
    });
    this.ready.catch(() => {});
    this.timer = setInterval(() => {
      if (this.enabled) void this.poll().catch(() => {});
    }, 45000).unref();
  }
  /** Prevent simultaneous reconnect/order/cancel flows within the single-host deployment. */
  async exclusive<T>(userId: string, action: () => Promise<T>): Promise<T> {
    await this.ready;
    if (this.stopped) fail(503, "Live service is shutting down.");
    if (this.busy.has(userId))
      fail(409, "Another live operation is in progress.");
    this.busy.add(userId);
    try {
      return await action();
    } finally {
      this.busy.delete(userId);
    }
  }
  /** Fetch only the authenticated owner's ICICI record, never an account ID from the browser. */
  async account(userId: string) {
    return (
      await this.store.transaction((query) =>
        query<LiveAccount>(
          "SELECT * FROM live_accounts WHERE user_id=$1 AND broker_binding LIKE 'icici:%'",
          [userId],
        ),
      )
    )[0];
  }
  /** Persistent minute/day budgets are shared with the market-data counter, leaving cancellation
   * headroom below the published account allowance. External apps still consume broker limits.
   */
  private async charge(userId: string, cancel: boolean) {
    await this.store.transaction(async (query) => {
      await lockWorkspaceSettings(query, this.store, userId);
      const day = iciciTradingDay(),
        minute = Math.floor(Date.now() / 60000) * 60000;
      const usage = (
        await query<{ usage_day: string; request_count: number }>(
          "SELECT * FROM broker_usage WHERE user_id=$1",
          [userId],
        )
      )[0];
      const window = (
        await query<{ window_start: number; request_count: number }>(
          "SELECT * FROM broker_rpc_windows WHERE user_id=$1",
          [userId],
        )
      )[0];
      const daily = usage?.usage_day === day ? usage.request_count : 0,
        count = window?.window_start === minute ? window.request_count : 0;
      if (daily >= (cancel ? 4800 : 4000) || count >= (cancel ? 80 : 60))
        fail(
          429,
          "ICICI request budget reached; verify pending orders directly at ICICI.",
        );
      await query(
        "INSERT INTO broker_usage VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET usage_day=$2,request_count=$3",
        [userId, day, daily + 1],
      );
      await query(
        "INSERT INTO broker_rpc_windows VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET window_start=$2,request_count=$3",
        [userId, minute, count + 1],
      );
    });
  }
  /** Final DB-backed authorization cannot be satisfied merely by setting a frontend mode flag. */
  private async authorize(
    query: Query,
    accountId: string,
    sessionHash?: string,
  ) {
    if (!this.enabled)
      fail(403, "Real order submission is disabled on this paper-only server.");
    if (this.stopped) fail(503, "Live service is shutting down.");
    if (!this.tradingWindow())
      fail(
        403,
        "New live orders are allowed only weekdays 09:20–15:15 IST. No AMO orders.",
      );
    const [permission] = await query<{
      armed_until: number;
      trading_day: string;
      expires: number;
      enabled: boolean;
    }>(
      "SELECT p.armed_until,p.trading_day,s.expires,m.enabled FROM live_permissions p JOIN live_accounts a ON a.id=p.account_id JOIN sessions s ON s.token_hash=p.session_hash AND s.user_id=a.user_id JOIN user_security m ON m.user_id=a.user_id WHERE p.account_id=$1 AND ($2::text IS NULL OR p.session_hash=$2)",
      [accountId, sessionHash || null],
    );
    if (
      !permission?.enabled ||
      permission.armed_until <= Date.now() ||
      permission.expires * 1000 <= Date.now() ||
      permission.trading_day !== iciciTradingDay()
    )
      fail(403, "Live permission expired or was revoked. Enable live again.");
    const pending = await query(
      "SELECT id FROM live_orders WHERE account_id=$1 AND state IN ('reserved','submitting','unknown','acknowledged','open','partially_filled')",
      [accountId],
    );
    if (pending.length > 5)
      fail(
        409,
        "Too many outstanding live orders. Cancel or wait for confirmation.",
      );
  }
  /** Connect using this user's encrypted saved credentials. Verifies broker identity; credentials
   * for a different ICICI account cannot replace a live account that already has order history.
   */
  async connect(userId: string) {
    const [saved] = await this.store.transaction((query) =>
      query<{ ciphertext: string; updated_at: string }>(
        "SELECT ciphertext,updated_at FROM broker_credentials WHERE user_id=$1",
        [userId],
      ),
    );
    if (!saved)
      fail(
        409,
        "Save your API key, API secret and API_Session in Brokers first.",
      );
    const existing = this.connections.get(userId);
    if (existing && existing.credentialVersion === saved.updated_at)
      return existing;
    if (existing) {
      await existing.service.haltAndCancel("Broker credentials changed");
      existing.adapter.close();
      this.connections.delete(userId);
    }
    if (this.connections.size >= 3)
      fail(503, "Live connection capacity reached.");
    const credentials = this.vault.open(
      userId,
      saved.ciphertext,
    ) as BreezeCredentials;
    if (
      !credentials?.apiKey ||
      !credentials.apiSecret ||
      !credentials.sessionToken
    )
      fail(409, "Saved ICICI credentials are incomplete.");
    const adapter = new IciciCashAdapter(
      credentials,
      (cancel) => this.charge(userId, cancel),
      this.factory,
    );
    try {
      await adapter.connect();
      let account = await this.account(userId);
      if (account && account.broker_binding !== adapter.accountBinding)
        fail(
          409,
          "Different ICICI account detected. Existing live history must be resolved first.",
        );
      if (!account) {
        await createLiveAccount(
          this.store,
          userId,
          adapter.accountBinding,
          limitsForCapital(1000),
        );
        account = (await this.account(userId))!;
      }
      const accountId = account.id;
      const service = new LiveExecutionService(
        this.store,
        userId,
        accountId,
        adapter,
        2500,
        (query) => this.authorize(query, accountId),
      );
      const connection = {
        adapter,
        service,
        credentialVersion: saved.updated_at,
      };
      this.connections.set(userId, connection);
      await this.updateKnownOrders(userId, connection);
      await service.haltAndCancel(
        "Live connection established; fresh confirmation required",
      );
      await service.reconcile();
      return connection;
    } catch (error) {
      adapter.close();
      this.connections.delete(userId);
      throw error;
    }
  }
  /** Seed remark correlation from durable intent keys, including crash/timeout records. */
  private async updateKnownOrders(userId: string, connection: Connection) {
    const account = await this.account(userId);
    const orders = await this.store.transaction((query) =>
      query<{ intent_key: string }>(
        "SELECT intent_key FROM live_orders WHERE account_id=$1",
        [account.id],
      ),
    );
    connection.adapter.setKnownIntents(orders.map((order) => order.intent_key));
  }
  /** Revoke before cancellation. Failure is visible; switching to paper never claims flatness. */
  async halt(userId: string, reason = "Switched to paper / live kill switch") {
    await this.ready;
    const account = await this.account(userId);
    if (!account) return { halted: true, unresolved: [] };
    await this.store.transaction(async (query) => {
      await query("SELECT id FROM live_accounts WHERE id=$1 FOR UPDATE", [
        account.id,
      ]);
      await query(
        "UPDATE live_permissions SET armed_until=0 WHERE account_id=$1",
        [account.id],
      );
      await query(
        "UPDATE live_accounts SET halted=TRUE,halt_reason=$2,reconciled_at=0 WHERE id=$1",
        [account.id, reason],
      );
    });
    const connection = this.connections.get(userId);
    if (!connection)
      return {
        halted: true,
        unresolved: [
          "Live connection unavailable. Verify/cancel orders directly at ICICI.",
        ],
      };
    await this.updateKnownOrders(userId, connection);
    return connection.service.haltAndCancel(reason);
  }
  /** UI polling reads cached DB state only; never spends broker requests or reveals credentials. */
  async status(userId: string) {
    await this.ready;
    const account = await this.account(userId);
    if (!account)
      return {
        connected: false,
        armed: false,
        halted: true,
        reason: "Connect ICICI live after saving credentials in Brokers.",
        orders: [],
        snapshot: null,
      };
    const [permission] = await this.store.transaction((query) =>
      query<{ armed_until: number }>(
        "SELECT armed_until FROM live_permissions WHERE account_id=$1",
        [account.id],
      ),
    );
    const orders = await this.store.transaction((query) =>
      query<{
        id: string;
        intent: string;
        state: string;
        broker_order: string;
      }>(
        "SELECT id,intent,state,broker_order FROM live_orders WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50",
        [account.id],
      ),
    );
    return {
      connected: this.connections.has(userId),
      armed: !account.halted && (permission?.armed_until || 0) > Date.now(),
      armedUntil: permission?.armed_until || 0,
      halted: account.halted,
      reason: account.halt_reason,
      reconciledAt: account.reconciled_at,
      limits: JSON.parse(account.limits),
      snapshot: account.snapshot ? JSON.parse(account.snapshot) : null,
      orders: orders.map((order) => ({
        ...order,
        intent: JSON.parse(order.intent),
        broker_order: order.broker_order
          ? JSON.parse(order.broker_order)
          : null,
      })),
    };
  }
  /** Background reconciliation does not depend on an open tab. Expired/revoked permissions
   * halt and cancel; disconnected accounts are reconnected only for recovery, never auto-armed.
   */
  private async poll() {
    await this.ready;
    if (this.stopped) return;
    const accounts = await this.store.transaction((query) =>
      query<LiveAccount>(
        "SELECT * FROM live_accounts WHERE broker_binding LIKE 'icici:%'",
      ),
    );
    for (const account of accounts) {
      if (this.stopped || this.busy.has(account.user_id)) continue;
      await this.exclusive(account.user_id, async () => {
        try {
          const connection = await this.connect(account.user_id);
          await this.updateKnownOrders(account.user_id, connection);
          try {
            await this.store.transaction((query) =>
              this.authorize(query, account.id),
            );
          } catch {
            await this.halt(
              account.user_id,
              "Live permission expired or revoked",
            );
          }
          await connection.service.reconcile();
        } catch {
          await this.halt(
            account.user_id,
            "ICICI connection/reconciliation failed; verify directly at broker",
          ).catch(() => {});
          this.connections.get(account.user_id)?.adapter.close();
          this.connections.delete(account.user_id);
        }
      }).catch(() => {});
    }
  }
  /** Close SDKs and stop timers. Persistent permissions are revoked on next startup; the
   * graceful shutdown path first calls haltAll so resting cancellations are attempted now.
   */
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const item of this.connections.values()) item.adapter.close();
    this.connections.clear();
  }
  async haltAll() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.ready;
    for (const userId of this.connections.keys())
      await this.halt(userId, "Server shutting down").catch(() => {});
    this.close();
  }

  /** Install separate live endpoints after session/CSRF middleware. No paper order is forwarded. */
  register(app: Express) {
    // Fail closed independently of UI state. Keep status and emergency halt available.
    app.use("/api/live", (req, res, next) => {
      if (!this.enabled && req.method !== "GET" && !req.path.endsWith("/halt"))
        return res
          .status(403)
          .json({
            detail:
              "Real order submission is disabled on this paper-only server.",
          });
      next();
    });
    const liveLimit = rateLimit(
      60,
      60000,
      (req) => req.res!.locals.session.user_id,
    );
    app.use("/api/live", (req, res, next) =>
      req.path === "/icici/halt" ? next() : liveLimit(req, res, next),
    );
    app.get("/api/live/icici", async (_req, res) =>
      res.json(await this.status(res.locals.session.user_id)),
    );
    // All live mutations require MFA enrollment, except the always-available risk-reducing halt.
    app.use("/api/live", async (req, res, next) => {
      if (req.method === "GET" || req.path.endsWith("/halt")) return next();
      const [security] = await this.store.transaction((query) =>
        query<{ enabled: boolean }>(
          "SELECT enabled FROM user_security WHERE user_id=$1",
          [res.locals.session.user_id],
        ),
      );
      if (!security?.enabled)
        fail(
          403,
          "Enable authenticator MFA in Account & security before live trading.",
        );
      next();
    });
    const action =
      (
        handler: (
          userId: string,
          req: import("express").Request,
          res: import("express").Response,
        ) => Promise<unknown>,
      ) =>
      async (
        req: import("express").Request,
        res: import("express").Response,
      ) => {
        const userId = res.locals.session.user_id;
        try {
          const result = await this.exclusive(userId, () =>
            handler(userId, req, res),
          );
          res.json(result);
        } catch (error) {
          if (
            error instanceof z.ZodError ||
            (error as { status?: number }).status
          )
            throw error;
          fail(
            409,
            error instanceof Error
              ? error.message
              : "Live operation failed. Verify directly at ICICI.",
          );
        }
      };
    app.post(
      "/api/live/icici/connect",
      action(async (userId) => {
        await this.connect(userId);
        return this.status(userId);
      }),
    );
    app.post(
      "/api/live/icici/refresh",
      action(async (userId) => {
        const connection = await this.connect(userId);
        await this.updateKnownOrders(userId, connection);
        await connection.service.reconcile();
        return this.status(userId);
      }),
    );
    app.post("/api/live/icici/halt", async (_req, res) =>
      res.json(await this.halt(res.locals.session.user_id)),
    );
    app.post(
      "/api/live/icici/arm",
      action(async (userId, req, res) => {
        const input = armInput.parse(req.body),
          connection = await this.connect(userId),
          account = (await this.account(userId))!;
        const [user] = await this.store.transaction((query) =>
          query<{ password_hash: string }>(
            "SELECT password_hash FROM users WHERE id=$1",
            [userId],
          ),
        );
        if (
          !equal(
            await passwordHash(
              input.password,
              user.password_hash.split(":")[0],
            ),
            user.password_hash,
          )
        )
          fail(403, "Current password is incorrect.");
        await this.store.transaction(async (query) => {
          await lockWorkspaceSettings(query, this.store, userId);
          const [current] = await query<{ password_hash: string }>(
            "SELECT password_hash FROM users WHERE id=$1",
            [userId],
          );
          if (!equal(current.password_hash, user.password_hash))
            fail(409, "Password changed. Sign in again.");
          await verifySecondFactor(query, this.vault, userId, input.token);
          await query("UPDATE live_accounts SET limits=$2 WHERE id=$1", [
            account.id,
            JSON.stringify(limitsForCapital(input.capitalInr)),
          ]);
          await query(
            "INSERT INTO live_permissions VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET session_hash=$2,armed_until=$3,trading_day=$4",
            [
              account.id,
              res.locals.session.token_hash,
              Date.now() + 15 * 60000,
              iciciTradingDay(),
            ],
          );
        });
        await connection.service.reconcile();
        await connection.service.resumeAfterReconciliation();
        return this.status(userId);
      }),
    );
    app.post(
      "/api/live/icici/preview",
      action(async (userId, req, res) => {
        const input = z
          .object({
            stockCode: z
              .string()
              .trim()
              .regex(/^[A-Z0-9 &_.-]{1,30}$/),
            side: z.enum(["buy", "sell"]),
            quantity: z.number().int().min(1).max(100),
            limitPaise: z.number().int().min(1).max(500000),
          })
          .strict()
          .parse(req.body);
        const connection = await this.connect(userId),
          account = (await this.account(userId))!;
        await this.store.transaction((query) =>
          this.authorize(query, account.id, res.locals.session.token_hash),
        );
        const pending = (await connection.service.status()).orders.filter(
          (order) =>
            [
              "reserved",
              "submitting",
              "unknown",
              "acknowledged",
              "open",
              "partially_filled",
            ].includes(order.state),
        );
        if (pending.length >= 5)
          fail(409, "At most five outstanding live orders are allowed.");
        await connection.service.reconcile();
        if ((await connection.service.status()).halted)
          fail(
            409,
            "Live account halted. Resolve broker state before previewing.",
          );
        const quote = await connection.adapter.getQuote(
          `NSE:${input.stockCode}`,
          input.side,
          AbortSignal.timeout(3000),
        );
        if (
          Math.abs(input.limitPaise - quote.pricePaise) / quote.pricePaise >
          0.05
        )
          fail(
            422,
            "Limit price is more than 5% from the executable-side quote.",
          );
        if (
          input.quantity * input.limitPaise >
          JSON.parse(account.limits).maxGrossExposurePaise
        )
          fail(422, "Order exceeds your live capital budget.");
        const id = randomUUID(),
          intent: OrderIntent = {
            key: id,
            instrument: `NSE:${input.stockCode}`,
            side: input.side,
            quantity: input.quantity,
            limitPaise: input.limitPaise,
            ...(input.side === "sell" ? { reduceOnly: true } : {}),
          };
        await this.store.transaction(async (query) => {
          await query(
            "DELETE FROM live_previews WHERE account_id=$1 AND expires<$2",
            [account.id, Date.now()],
          );
          await query("INSERT INTO live_previews VALUES($1,$2,$3,$4,$5)", [
            id,
            account.id,
            res.locals.session.token_hash,
            JSON.stringify(intent),
            Date.now() + 120000,
          ]);
        });
        return {
          previewId: id,
          intent,
          notionalPaise: input.quantity * input.limitPaise,
          expiresAt: Date.now() + 120000,
        };
      }),
    );
    app.post(
      "/api/live/icici/orders",
      action(async (userId, req, res) => {
        const input = z
          .object({
            previewId: z.uuid(),
            confirmation: z.literal("PLACE LIVE ORDER"),
          })
          .strict()
          .parse(req.body);
        const connection = await this.connect(userId),
          account = (await this.account(userId))!;
        const [preview] = await this.store.transaction((query) =>
          query<{ intent: string; expires: number }>(
            "SELECT intent,expires FROM live_previews WHERE id=$1 AND account_id=$2 AND session_hash=$3",
            [input.previewId, account.id, res.locals.session.token_hash],
          ),
        );
        if (!preview || preview.expires < Date.now())
          fail(409, "Preview expired. Review a new order.");
        await this.store.transaction((query) =>
          this.authorize(query, account.id, res.locals.session.token_hash),
        );
        await this.updateKnownOrders(userId, connection);
        await connection.service.reconcile();
        const order = await connection.service.reserveIntent(
          JSON.parse(preview.intent),
        );
        const result = await connection.service.submitReservedOrder(order.id);
        return {
          orderId: result.id,
          state: result.state,
          message:
            result.state === "unknown"
              ? "Outcome unknown. Do not resubmit; verify at ICICI."
              : "Request recorded. Check broker-confirmed status.",
        };
      }),
    );
  }
}
