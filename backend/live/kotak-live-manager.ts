/** Separate real-money control plane. Research and replay cannot reach this manager.
 * One API process owns each connected session. Restarts/reconnects invalidate arming.
 */
import { randomUUID } from "node:crypto";
import { lockWorkspaceSettings, type Store, type Query } from "../database.js";
import { credentialVault, digest, fail } from "../security.js";
import { verifySecondFactor, withMfaAttempt } from "../mfa.js";
import type { LoginSession } from "../types.js";
import type {
  InstrumentCatalog,
  InstrumentSearch,
} from "../instrument-master.js";
import type { KotakMarketDataClient } from "../kotak-market-data-client.js";
import { tradingDay } from "../market-contracts.js";
import {
  resolveActiveBroker,
  type ActiveBrokerBinding,
} from "../broker-registry.js";
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
  brokerId: string;
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
  public readonly provider = "kotak" as const;
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
  /** Fail closed when execution is disabled or the manager is shutting down. */
  private requireEnabled() {
    if (!this.enabled || this.closed) {
      fail(409, "Live execution is disabled on this server.");
    }
  }
  /** Serialize account work; a prior rejection releases the queue but never retries dispatch. */
  private serial<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
    const work = entry.tail.catch(() => {}).then(action);
    entry.tail = work.catch(() => {});
    return work;
  }
  /** Recheck broker identity, durable session, permission expiry and trading day before dispatch. */
  private async authorize(query: Query, entry: Entry) {
    this.requireEnabled();
    if (entry.revoked || !entry.connection.isCurrent()) {
      fail(
        409,
        "Reconnect the active broker and explicitly arm live execution again.",
      );
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
      permission.trading_day !== tradingDay(Date.now())
    ) {
      fail(409, "Live permission expired or revoked. Reconcile and arm again.");
    }
  }
  /** Reuse only the current account/session and serialize initialization of explicit execution control. */
  private async entry(
    session: LoginSession,
    limits?: RiskLimits,
  ): Promise<Entry> {
    this.requireEnabled();
    const active = await this.store.transaction((query) =>
      resolveActiveBroker(query, session.user_id),
    );
    if (active.provider !== this.provider) {
      fail(
        409,
        `Live execution is not implemented for the active ${active.provider} broker.`,
      );
    }
    if (!this.client.isConnected(session.user_id, session.token_hash)) {
      fail(409, "Reconnect the active Kotak broker first.");
    }
    const current = this.entries.get(active.id);
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
    const previous = this.pending.get(active.id);
    if (previous) {
      await previous;
      return this.entry(session, limits);
    }
    const work = this.open(session, active, limits);
    this.pending.set(active.id, work);
    try {
      return await work;
    } finally {
      this.pending.delete(active.id);
    }
  }
  /** Initialize an explicitly requested control session with a durable halt and bounded monitoring. */
  private async open(
    session: LoginSession,
    active: ActiveBrokerBinding,
    limits?: RiskLimits,
  ): Promise<Entry> {
    const connection = this.client.executionSession(
      session.user_id,
      session.token_hash,
    );
    if (connection.accountBinding !== active.accountBinding) {
      fail(
        409,
        "The active broker account does not match the authenticated execution session.",
      );
    }
    const id = await this.store.transaction(async (query) => {
      if (limits) {
        await query(
          "INSERT INTO live_accounts(id,user_id,broker_binding,halt_reason,limits,broker_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(broker_binding) DO UPDATE SET broker_id=COALESCE(live_accounts.broker_id,EXCLUDED.broker_id)",
          [
            randomUUID(),
            session.user_id,
            connection.accountBinding,
            "Explicit reconciliation and arming required",
            JSON.stringify(riskLimitsSchema.parse(limits)),
            active.id,
          ],
        );
      }
      const [account] = await query<{ id: string }>(
        "SELECT id FROM live_accounts WHERE user_id=$1 AND broker_binding=$2 AND broker_id=$3 FOR UPDATE",
        [session.user_id, connection.accountBinding, active.id],
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
      await query(
        "UPDATE live_orders SET state='blocked' WHERE account_id=$1 AND broker_id=$2 AND state='bound'",
        [account.id, active.id],
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
        const quote = await this.client.getTopOfBookQuote(
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
      brokerId: active.id,
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
      active.id,
    );
    this.entries.set(active.id, entry);
    this.schedule(entry);
    return entry;
  }
  /** Monitor sequentially; lost authorization latches halt and cannot auto-arm the account. */
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
  /** Configure a halted account with validated limits; this grants no trading permission. */
  public async configure(session: LoginSession, limits: RiskLimits) {
    const entry = await this.entry(session, limits);
    return this.status(session, entry);
  }
  /** Resolve current supported contracts for the authenticated session without submitting orders. */
  public async instruments(session: LoginSession, input: InstrumentSearch) {
    this.requireEnabled();
    const active = await this.store.transaction((query) =>
      resolveActiveBroker(query, session.user_id),
    );
    if (active.provider !== this.provider) {
      fail(
        409,
        `Live execution is not implemented for the active ${active.provider} broker.`,
      );
    }
    if (!this.client.isConnected(session.user_id, session.token_hash)) {
      fail(409, "Reconnect the active Kotak broker first.");
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
  /** Read durable state without opening an execution session, changing permissions or scheduling cancellation. */
  public async status(session: LoginSession, existing?: Entry) {
    if (!this.enabled) {
      return {
        enabled: false,
        armed: false,
        halted: true,
        reason: "Live execution disabled",
      };
    }
    let active: ActiveBrokerBinding;
    try {
      active = await this.store.transaction((query) =>
        resolveActiveBroker(query, session.user_id),
      );
    } catch (error) {
      return {
        enabled: true,
        armed: false,
        halted: true,
        reason:
          (error as { detail?: string }).detail ??
          "Connect and select an active broker first.",
        orders: [],
      };
    }
    if (active.provider !== this.provider) {
      return {
        enabled: true,
        armed: false,
        halted: true,
        activeBrokerId: active.id,
        provider: active.provider,
        reason: `Live execution is not implemented for the active ${active.provider} broker.`,
        orders: [],
      };
    }
    const entry = existing ?? this.entries.get(active.id);
    if (
      !entry ||
      entry.revoked ||
      entry.session.token_hash !== session.token_hash ||
      !entry.connection.isCurrent()
    ) {
      return this.readDormantStatus(session, active);
    }
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
      activeBrokerId: entry.brokerId,
      provider: this.provider,
      enabled: true,
      armed,
      limits: JSON.parse(account.limits),
      snapshot: account.snapshot ? JSON.parse(account.snapshot) : null,
      accounting: "broker-rms (cash-ledger drift checks unavailable)",
      orders: status.orders.map((o) => ({
        id: o.id,
        brokerId: o.broker_id,
        state: o.state,
        intent: JSON.parse(o.intent),
        brokerOrder: o.broker_order ? JSON.parse(o.broker_order) : null,
      })),
    };
  }
  /** A disconnected/restarted control plane may display its own saved records, but never imply it is armed. */
  private async readDormantStatus(
    session: LoginSession,
    active: ActiveBrokerBinding,
  ) {
    return this.store.transaction(async (query) => {
      const [account] = await query<{
        id: string;
        limits: string;
        snapshot: string;
      }>(
        "SELECT id,limits,snapshot FROM live_accounts WHERE user_id=$1 AND broker_binding=$2 AND broker_id=$3",
        [session.user_id, active.accountBinding, active.id],
      );
      if (!account) {
        return {
          enabled: true,
          armed: false,
          halted: true,
          reason:
            "Configure live risk limits before reconciliation and arming.",
          orders: [],
          activeBrokerId: active.id,
          provider: active.provider,
        };
      }
      const orders = await query<{
        id: string;
        state: string;
        intent: string;
        broker_order: string;
        broker_id: string | null;
      }>(
        "SELECT id,state,intent,broker_order,broker_id FROM live_orders WHERE account_id=$1 ORDER BY created_at",
        [account.id],
      );
      return {
        enabled: true,
        armed: false,
        halted: true,
        accountId: account.id,
        activeBrokerId: active.id,
        provider: active.provider,
        reason:
          "Execution session inactive. Explicit reconciliation and arming required; check broker exposure.",
        limits: JSON.parse(account.limits),
        snapshot: account.snapshot ? JSON.parse(account.snapshot) : null,
        accounting: "broker-rms (cash-ledger drift checks unavailable)",
        orders: orders.map(
          /** Project stored order records only; never contact the broker from a status read. */ (
            order,
          ) => ({
            id: order.id,
            brokerId: order.broker_id,
            state: order.state,
            intent: JSON.parse(order.intent),
            brokerOrder: order.broker_order
              ? JSON.parse(order.broker_order)
              : null,
          }),
        ),
      };
    });
  }
  /** Serialize explicit reconciliation; unresolved exposure remains halted. */
  public async reconcile(session: LoginSession) {
    const entry = await this.entry(session);
    return this.serial(entry, () => entry.service.reconcile());
  }
  /** Consume MFA proof and grant short-lived session-bound permission only after clean reconciliation. */
  public async arm(session: LoginSession, token: string) {
    const entry = await this.entry(session);
    return this.serial(entry, async () => {
      // Validate MFA before any broker work, then grant short-lived, boot/session-bound permission.
      await withMfaAttempt(this.store, session.user_id, async (query) => {
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
          // Serialize permission grants with broker selection so a concurrent switch
          // cannot leave permission attached to the broker we just switched away from.
          const active = await resolveActiveBroker(
            query,
            session.user_id,
            true,
          );
          if (active.id !== entry.brokerId) {
            fail(
              409,
              "Active broker changed while arming. Authorize the selected broker again.",
            );
          }
          if (entry.revoked || !entry.connection.isCurrent()) {
            fail(409, "Broker session changed while arming.");
          }
          await query(
            "INSERT INTO live_permissions(account_id,session_hash,armed_until,trading_day) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET session_hash=EXCLUDED.session_hash,armed_until=EXCLUDED.armed_until,trading_day=EXCLUDED.trading_day",
            [entry.id, entry.permissionKey, armedUntil, tradingDay(Date.now())],
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
  /** Validate intent and price, then persist a short-lived preview without submitting an order. */
  public async preview(session: LoginSession, input: Omit<OrderIntent, "key">) {
    const entry = await this.entry(session);
    return this.serial(entry, async () => {
      await this.store.transaction((q) => this.authorize(q, entry));
      const intent = orderIntentSchema.parse({ ...input, key: randomUUID() });
      const contract = entry.adapter.validateIntent(intent);
      if (!Number.isSafeInteger(intent.quantity * intent.limitPaise)) {
        fail(422, "Order notional exceeds safe arithmetic.");
      }
      const id = randomUUID(),
        expires = Date.now() + 30000;
      await this.store.transaction(async (q) => {
        await this.authorize(q, entry);
        const active = await resolveActiveBroker(q, session.user_id, true);
        if (
          active.id !== entry.brokerId ||
          active.accountBinding !== entry.adapter.accountBinding
        ) {
          fail(409, "Active broker changed. Start a new live-order review.");
        }
        await q(
          "DELETE FROM live_previews WHERE account_id=$1 AND expires<$2",
          [entry.id, Date.now()],
        );
        await q(
          "INSERT INTO live_previews(id,account_id,session_hash,intent,expires,broker_id) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            entry.id,
            entry.permissionKey,
            JSON.stringify(intent),
            expires,
            entry.brokerId,
          ],
        );
      });
      let quote;
      try {
        quote = await withBrokerDeadline(
          (s) => entry.adapter.getQuote(intent.instrument, intent.side, s),
          3000,
        );
        if (
          Math.abs(intent.limitPaise - quote.pricePaise) / quote.pricePaise >
          0.05
        ) {
          fail(
            422,
            "Limit price must be within 5% of the current broker quote.",
          );
        }
      } catch (error) {
        await this.store
          .transaction((q) =>
            q(
              "DELETE FROM live_previews WHERE id=$1 AND account_id=$2 AND broker_id=$3",
              [id, entry.id, entry.brokerId],
            ),
          )
          .catch(() => {});
        throw error;
      }
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
  /** Resolve a durable preview intent and dispatch at most once; repeated confirmations reuse its identity. */
  public async submit(session: LoginSession, previewId: string) {
    const entry = await this.entry(session);
    return this.serial(entry, async () => {
      const intent = await this.store.transaction(async (q) => {
        await this.authorize(q, entry);
        const [preview] = await q<{
          intent: string;
          expires: number;
          broker_id: string | null;
        }>(
          "SELECT intent,expires,broker_id FROM live_previews WHERE id=$1 AND account_id=$2 AND session_hash=$3",
          [previewId, entry.id, entry.permissionKey],
        );
        if (!preview || preview.expires <= Date.now()) {
          fail(409, "Order preview expired. Review a new preview.");
        }
        if (preview.broker_id !== entry.brokerId) {
          fail(409, "Order preview belongs to another broker.");
        }
        return orderIntentSchema.parse(JSON.parse(preview.intent));
      });
      // A repeated confirmation resolves the SAME durable intent; no second broker call.
      const prior = (await entry.service.status()).orders.find(
        (o) => o.intent_key === intent.key,
      );
      if (prior && !new Set(["bound", "reserved"]).has(prior.state)) {
        return prior;
      }
      const bound = await entry.service.bindIntent(intent);
      if (!new Set(["bound", "reserved"]).has(bound.state)) {
        return bound;
      }
      try {
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
        const order = await entry.service.reserveBoundIntent(bound.id);
        return entry.service.submitReservedOrder(order.id);
      } catch (error) {
        await entry.service
          .blockReservedOrder(
            bound.id,
            "Pre-dispatch quote or reconciliation gate failed",
          )
          .catch(() => {});
        throw error;
      }
    });
  }
  /** Revoke permission before cancellation work; never auto-flatten positions or queue the kill behind previews. */
  public async halt(session: LoginSession) {
    // A kill is account-owned, not connectivity-dependent. Never initialize an
    // adapter (or require a valid broker session) merely to revoke permission.
    const entries = [...this.entries.values()].filter(
      (entry) => entry.session.user_id === session.user_id,
    );
    for (const entry of entries) {
      entry.revoked = true;
      clearTimeout(entry.timer);
    }
    // Durable account gate competes with dispatch; do not queue a kill behind preview work.
    await this.store.transaction((q) =>
      q(
        "DELETE FROM live_permissions WHERE account_id IN (SELECT id FROM live_accounts WHERE user_id=$1)",
        [session.user_id],
      ),
    );
    const accounts = await this.store.transaction(async (q) => {
      const accounts = await q<{ id: string }>(
        "UPDATE live_accounts SET halted=TRUE,halt_reason=$2,generation=generation+1,reconciled_at=0 WHERE user_id=$1 RETURNING id",
        [
          session.user_id,
          "User halted live execution; verify remaining exposure at the broker",
        ],
      );
      for (const account of accounts) {
        await q(
          "UPDATE live_orders SET state='blocked' WHERE account_id=$1 AND state IN ('bound','reserved')",
          [account.id],
        );
        await q(
          "INSERT INTO live_events(account_id,kind,detail,created_at) VALUES($1,'halt',$2,$3)",
          [
            account.id,
            "Operator kill; permission revoked regardless of broker connectivity",
            Date.now(),
          ],
        );
      }
      return accounts;
    });
    const unresolved: string[] = [];
    for (const account of accounts) {
      const entry = entries.find((candidate) => candidate.id === account.id);
      if (!entry) {
        unresolved.push("broker-state-unavailable");
        continue;
      }
      try {
        const result = await entry.service.haltAndCancel(
          "User halted live execution; positions are not flattened",
        );
        unresolved.push(...result.unresolved);
      } catch {
        unresolved.push("broker-state-unavailable");
      }
    }
    return {
      halted: true,
      cancellationConfirmed: false,
      unresolved: [...new Set(unresolved)],
    };
  }
  /** Block dispatch immediately and persist revocation best effort; outstanding broker exposure may remain. */
  public revoke(userId: string) {
    for (const entry of this.entries.values()) {
      if (entry.session.user_id !== userId) {
        continue;
      }
      entry.revoked = true;
      clearTimeout(entry.timer);
      // Synchronous memory gate blocks dispatch immediately. Durable halt follows best effort.
      void this.store
        .transaction(async (q) => {
          await q("DELETE FROM live_permissions WHERE account_id=$1", [
            entry.id,
          ]);
          await q(
            "UPDATE live_accounts SET halted=TRUE,halt_reason=$2,reconciled_at=0 WHERE id=$1",
            [
              entry.id,
              "Session revoked: check and cancel remaining orders at the bound broker",
            ],
          );
        })
        .catch(() => {});
    }
  }
  /** Stop monitoring and attempt owned-order cancellation; failure never implies broker exposure is closed. */
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
