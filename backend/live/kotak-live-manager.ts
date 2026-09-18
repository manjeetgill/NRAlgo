/** Separate real-money control plane. Nothing in paper/replay can reach this manager.
 * One API process owns each connected session. Restarts/reconnects invalidate arming.
 */
import { randomUUID } from "node:crypto";
import { lockWorkspaceSettings, type Store, type Query } from "../database.js";
import { credentialVault, digest, fail } from "../security.js";
import { verifySecondFactor } from "../mfa.js";
import type { LoginSession } from "../types.js";
import type {
  InstrumentCatalog,
  InstrumentSearch,
} from "../instrument-master.js";
import type { KotakMarketDataClient } from "../kotak-market-data-client.js";
import { paperTradingDay } from "../paper-trading-ledger.js";
import { LiveExecutionService } from "./execution.js";
import {
  KotakLiveAdapter,
  type KotakExecutionSession,
} from "./kotak-live-adapter.js";
import {
  orderIntentSchema,
  riskLimitsSchema,
  terminalStates,
  withBrokerDeadline,
  type OrderIntent,
  type RiskLimits,
} from "./contracts.js";

type Entry = {
  id: string;
  session: LoginSession;
  connection: KotakExecutionSession;
  adapter: KotakLiveAdapter;
  service: LiveExecutionService;
  permissionKey: string;
  tail: Promise<unknown>;
  revoked: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
export class KotakLiveManager {
  readonly enabled: boolean;
  private readonly bootId = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private closed = false;
  constructor(
    private readonly store: Store,
    private readonly client: KotakMarketDataClient,
    private readonly catalog: InstrumentCatalog,
    env: NodeJS.ProcessEnv,
    private readonly vault: ReturnType<typeof credentialVault>,
  ) {
    this.enabled = env.LIVE_TRADING_ENABLED === "true";
    if (this.enabled && env.KOTAK_STATIC_IP_CONFIRMED !== "true") {
      throw new Error(
        "Live trading requires KOTAK_STATIC_IP_CONFIRMED=true after Kotak IP registration",
      );
    }
  }
  private requireEnabled() {
    if (!this.enabled || this.closed) {
      fail(409, "Live execution is disabled on this server.");
    }
  }
  private serial<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
    const work = entry.tail.catch(() => {}).then(action);
    entry.tail = work.catch(() => {});
    return work;
  }
  private async authorize(query: Query, entry: Entry) {
    this.requireEnabled();
    if (entry.revoked || !entry.connection.isCurrent()) {
      fail(409, "Reconnect Kotak and explicitly arm live execution again.");
    }
    const [permission] = await query<{
      armed_until: number;
      trading_day: string;
    }>(
      "SELECT armed_until,trading_day FROM live_permissions WHERE account_id=$1 AND session_hash=$2",
      [entry.id, entry.permissionKey],
    );
    const validSession = await query(
      "SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires>$3",
      [entry.session.token_hash, entry.session.user_id, Date.now() / 1000],
    );
    if (
      !permission ||
      !validSession.length ||
      permission.armed_until <= Date.now() ||
      permission.trading_day !== paperTradingDay(Date.now())
    ) {
      fail(409, "Live permission expired or revoked. Reconcile and arm again.");
    }
  }
  private async entry(
    session: LoginSession,
    limits?: RiskLimits,
  ): Promise<Entry> {
    this.requireEnabled();
    const current = this.entries.get(session.user_id);
    if (
      current &&
      !current.revoked &&
      current.session.token_hash === session.token_hash &&
      current.connection.isCurrent()
    ) {
      return current;
    }
    if (current) {
      current.revoked = true;
      clearTimeout(current.timer);
    }
    const previous = this.pending.get(session.user_id);
    if (previous) {
      await previous;
      return this.entry(session, limits);
    }
    const work = this.open(session, limits);
    this.pending.set(session.user_id, work);
    try {
      return await work;
    } finally {
      this.pending.delete(session.user_id);
    }
  }
  private async open(
    session: LoginSession,
    limits?: RiskLimits,
  ): Promise<Entry> {
    const connection = this.client.executionSession(
      session.user_id,
      session.token_hash,
    );
    const id = await this.store.transaction(async (query) => {
      if (limits) {
        await query(
          "INSERT INTO live_accounts(id,user_id,broker_binding,halt_reason,limits) VALUES($1,$2,$3,$4,$5) ON CONFLICT(broker_binding) DO NOTHING",
          [
            randomUUID(),
            session.user_id,
            connection.accountBinding,
            "Explicit reconciliation and arming required",
            JSON.stringify(riskLimitsSchema.parse(limits)),
          ],
        );
      }
      const [account] = await query<{ id: string }>(
        "SELECT id FROM live_accounts WHERE user_id=$1 AND broker_binding=$2 FOR UPDATE",
        [session.user_id, connection.accountBinding],
      );
      if (!account) {
        fail(
          409,
          "Configure live risk limits first. A broker account cannot be shared across app users.",
        );
      }
      await query("DELETE FROM live_permissions WHERE account_id=$1", [
        account.id,
      ]);
      await query(
        "UPDATE live_accounts SET halted=TRUE,halt_reason=$2,reconciled_at=0 WHERE id=$1",
        [account.id, "New server/broker session: explicit re-arming required"],
      );
      return account.id;
    });
    const adapter = new KotakLiveAdapter(
      connection,
      (token) => this.catalog.resolveLive(token),
      async () =>
        this.store.transaction(async (query) =>
          (
            await query<{ intent: string }>(
              "SELECT intent FROM live_orders WHERE account_id=$1",
              [id],
            )
          ).map((r) => orderIntentSchema.parse(JSON.parse(r.intent))),
        ),
      async (contract, signal) => {
        signal.throwIfAborted();
        const quote = await this.client.getPaperFillQuote(
          session.user_id,
          session.token_hash,
          contract.instrument,
          contract.market === "cash" ? "nse_cm" : "nse_fo",
          signal,
        );
        signal.throwIfAborted();
        return {
          pricePaise: Math.max(quote.bid, quote.ask),
          observedAt: quote.observedAt,
        };
      },
    );
    const entry = {
      id,
      session,
      connection,
      adapter,
      permissionKey: digest(
        `${session.token_hash}:${this.bootId}:${randomUUID()}`,
      ),
      tail: Promise.resolve(),
      revoked: false,
    } as Entry;
    entry.service = new LiveExecutionService(
      this.store,
      session.user_id,
      id,
      adapter,
      3000,
      (query) => this.authorize(query, entry),
    );
    this.entries.set(session.user_id, entry);
    this.schedule(entry);
    return entry;
  }
  private schedule(entry: Entry) {
    if (this.closed || entry.revoked) {
      return;
    }
    entry.timer = setTimeout(() => {
      void this.serial(entry, async () => {
        try {
          if (!entry.connection.isCurrent()) {
            entry.revoked = true;
            throw new Error("Disconnected");
          }
          const status = await entry.service.status();
          if (!status.halted) {
            try {
              await this.store.transaction((q) => this.authorize(q, entry));
            } catch {
              await entry.service.haltAndCancel(
                "Live permission expired or session revoked; check remaining positions at broker",
              );
              return;
            }
          }
          if (
            !status.halted ||
            status.orders.some((o) => !terminalStates.has(o.state))
          ) {
            await entry.service.reconcile();
          }
        } catch {
          await this.store
            .transaction(async (q) => {
              await q("DELETE FROM live_permissions WHERE account_id=$1", [
                entry.id,
              ]);
              await q(
                "UPDATE live_accounts SET halted=TRUE,halt_reason=$2,reconciled_at=0 WHERE id=$1",
                [
                  entry.id,
                  "Live monitoring unavailable; check broker orders and exposure",
                ],
              );
            })
            .catch(() => {
              entry.revoked = true;
            });
        }
      }).finally(() => this.schedule(entry));
    }, 2000);
    entry.timer.unref();
  }
  public async configure(session: LoginSession, limits: RiskLimits) {
    const entry = await this.entry(session, limits);
    return this.status(session, entry);
  }
  public async instruments(session: LoginSession, input: InstrumentSearch) {
    this.requireEnabled();
    if (!this.client.isConnected(session.user_id, session.token_hash)) {
      fail(409, "Connect Kotak first.");
    }
    if (!this.catalog.isFresh("kotak", input.market)) {
      const url = await this.client.getInstrumentMasterUrl(
        session.user_id,
        session.token_hash,
        input.market,
      );
      await this.catalog.load("kotak", input.market, url);
    }
    return this.catalog.search("kotak", input);
  }
  public async status(session: LoginSession, existing?: Entry) {
    if (!this.enabled) {
      return {
        enabled: false,
        armed: false,
        halted: true,
        reason: "Live execution disabled",
      };
    }
    const entry = existing ?? (await this.entry(session));
    const status = await entry.service.status();
    const [account] = await this.store.transaction((q) =>
      q<{ limits: string; snapshot: string }>(
        "SELECT limits,snapshot FROM live_accounts WHERE id=$1 AND user_id=$2",
        [entry.id, session.user_id],
      ),
    );
    let armed = false;
    try {
      await this.store.transaction((q) => this.authorize(q, entry));
      armed = !status.halted;
    } catch {
      /* fail closed */
    }
    return {
      ...status,
      accountId: entry.id,
      enabled: true,
      armed,
      limits: JSON.parse(account.limits),
      snapshot: account.snapshot ? JSON.parse(account.snapshot) : null,
      accounting: "broker-rms (cash-ledger drift checks unavailable)",
      orders: status.orders.map((o) => ({
        id: o.id,
        state: o.state,
        intent: JSON.parse(o.intent),
        brokerOrder: o.broker_order ? JSON.parse(o.broker_order) : null,
      })),
    };
  }
  public async reconcile(session: LoginSession) {
    const entry = await this.entry(session);
    return this.serial(entry, () => entry.service.reconcile());
  }
  public async arm(session: LoginSession, token: string) {
    const entry = await this.entry(session);
    return this.serial(entry, async () => {
      // Validate MFA before any broker work, then grant short-lived, boot/session-bound permission.
      await this.store.transaction(async (query) => {
        await lockWorkspaceSettings(query, this.store, session.user_id);
        const [security] = await query<{ enabled: boolean }>(
          "SELECT enabled FROM user_security WHERE user_id=$1",
          [session.user_id],
        );
        if (!security?.enabled) {
          fail(409, "Enable authenticator MFA before live trading.");
        }
        await verifySecondFactor(query, this.vault, session.user_id, token);
      });
      if (!(await entry.service.reconcile()).clean) {
        fail(
          409,
          "Broker reconciliation failed. Review live status; no orders enabled.",
        );
      }
      if (entry.revoked) {
        fail(409, "Live arming cancelled.");
      }
      await entry.service.resumeAfterReconciliation();
      const armedUntil = Math.min(
        Date.now() + 5 * 60000,
        session.expires * 1000,
      );
      try {
        await this.store.transaction(async (query) => {
          if (entry.revoked || !entry.connection.isCurrent()) {
            fail(409, "Broker session changed while arming.");
          }
          await query(
            "INSERT INTO live_permissions(account_id,session_hash,armed_until,trading_day) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET session_hash=EXCLUDED.session_hash,armed_until=EXCLUDED.armed_until,trading_day=EXCLUDED.trading_day",
            [
              entry.id,
              entry.permissionKey,
              armedUntil,
              paperTradingDay(Date.now()),
            ],
          );
          await query(
            "INSERT INTO live_events(account_id,kind,detail,created_at) VALUES($1,'armed',$2,$3)",
            [
              entry.id,
              "MFA-confirmed, session-bound five-minute live permission",
              Date.now(),
            ],
          );
        });
      } catch (error) {
        await entry.service.haltAndCancel(
          "Arming interrupted; no live permission granted",
        );
        throw error;
      }
      return { armed: true, armedUntil };
    });
  }
  public async preview(session: LoginSession, input: Omit<OrderIntent, "key">) {
    const entry = await this.entry(session);
    return this.serial(entry, async () => {
      await this.store.transaction((q) => this.authorize(q, entry));
      const intent = orderIntentSchema.parse({ ...input, key: randomUUID() });
      const contract = entry.adapter.validateIntent(intent);
      if (!Number.isSafeInteger(intent.quantity * intent.limitPaise)) {
        fail(422, "Order notional exceeds safe arithmetic.");
      }
      const quote = await withBrokerDeadline(
        (s) => entry.adapter.getQuote(intent.instrument, intent.side, s),
        3000,
      );
      if (
        Math.abs(intent.limitPaise - quote.pricePaise) / quote.pricePaise >
        0.05
      ) {
        fail(422, "Limit price must be within 5% of the current broker quote.");
      }
      const id = randomUUID(),
        expires = Date.now() + 30000;
      await this.store.transaction(async (q) => {
        await this.authorize(q, entry);
        await q(
          "DELETE FROM live_previews WHERE account_id=$1 AND expires<$2",
          [entry.id, Date.now()],
        );
        await q(
          "INSERT INTO live_previews(id,account_id,session_hash,intent,expires) VALUES($1,$2,$3,$4,$5)",
          [id, entry.id, entry.permissionKey, JSON.stringify(intent), expires],
        );
      });
      return {
        previewId: id,
        expires,
        intent,
        tradingSymbol: contract.name,
        quote,
        notionalPaise: intent.quantity * intent.limitPaise,
        confirmation: "PLACE LIVE ORDER",
        warning:
          "Real money. Limit DAY order. Execution and charges are not guaranteed.",
      };
    });
  }
  public async submit(session: LoginSession, previewId: string) {
    const entry = await this.entry(session);
    return this.serial(entry, async () => {
      const intent = await this.store.transaction(async (q) => {
        await this.authorize(q, entry);
        const [preview] = await q<{ intent: string; expires: number }>(
          "SELECT intent,expires FROM live_previews WHERE id=$1 AND account_id=$2 AND session_hash=$3",
          [previewId, entry.id, entry.permissionKey],
        );
        if (!preview || preview.expires <= Date.now()) {
          fail(409, "Order preview expired. Review a new preview.");
        }
        return orderIntentSchema.parse(JSON.parse(preview.intent));
      });
      // A repeated confirmation resolves the SAME durable intent; no second broker call.
      const prior = (await entry.service.status()).orders.find(
        (o) => o.intent_key === intent.key,
      );
      if (prior && prior.state !== "reserved") {
        return prior;
      }
      entry.adapter.validateIntent(intent);
      const quote = await withBrokerDeadline(
        (s) => entry.adapter.getQuote(intent.instrument, intent.side, s),
        3000,
      );
      if (
        Math.abs(intent.limitPaise - quote.pricePaise) / quote.pricePaise >
        0.05
      ) {
        fail(
          409,
          "Price moved outside the preview guard; review a fresh preview.",
        );
      }
      if (!(await entry.service.reconcile()).clean) {
        fail(409, "Reconciliation failed; order not submitted.");
      }
      const order = await entry.service.reserveIntent(intent);
      return entry.service.submitReservedOrder(order.id);
    });
  }
  public async halt(session: LoginSession) {
    const entry = await this.entry(session);
    entry.revoked = true;
    clearTimeout(entry.timer);
    // Durable account gate competes with dispatch; do not queue a kill behind preview work.
    await this.store.transaction((q) =>
      q("DELETE FROM live_permissions WHERE account_id=$1", [entry.id]),
    );
    return entry.service.haltAndCancel(
      "User halted live execution; cancellation requested, positions are not flattened",
    );
  }
  public revoke(userId: string) {
    const entry = this.entries.get(userId);
    if (!entry) {
      return;
    }
    entry.revoked = true;
    clearTimeout(entry.timer);
    // Synchronous memory gate blocks dispatch immediately. Durable halt follows best effort.
    void this.store
      .transaction(async (q) => {
        await q("DELETE FROM live_permissions WHERE account_id=$1", [entry.id]);
        await q(
          "UPDATE live_accounts SET halted=TRUE,halt_reason=$2,reconciled_at=0 WHERE id=$1",
          [
            entry.id,
            "Session revoked: check and cancel remaining orders at Kotak",
          ],
        );
      })
      .catch(() => {});
  }
  public async close() {
    this.closed = true;
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        entry.revoked = true;
        clearTimeout(entry.timer);
        await entry.tail;
        await entry.service
          .haltAndCancel("API shutdown: live disabled; verify broker exposure")
          .catch(() => {});
      }),
    );
  }
}
