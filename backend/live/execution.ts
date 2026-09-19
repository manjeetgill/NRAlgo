/** Durable order boundary shared by offline fixtures and the separately gated live API.
 * Offline broker fixtures exercise the same database transitions as production.
 * A submission is persisted BEFORE network I/O; uncertain outcomes never return to a queue.
 * Account locks serialize reservations/submissions/halts. Network operations have short deadlines.
 */
import { randomUUID } from "node:crypto";
import type { Query, Store } from "../database.js";
import { resolveActiveBroker } from "../broker-registry.js";
import {
  brokerOrderSchema,
  brokerSnapshotSchema,
  DefinitiveOrderRejection,
  maximumSnapshotAgeMs,
  orderIntentSchema,
  riskLimitsSchema,
  terminalStates,
  withBrokerDeadline,
  type BrokerOrder,
  type BrokerSnapshot,
  type ExecutionBrokerAdapter,
  type OrderIntent,
  type OrderState,
  type RiskLimits,
} from "./contracts.js";
import { evaluateLiveRisk } from "./risk.js";
import {
  spreadPlanSchema,
  boundedExposureLimit,
  describeOrphanExposure,
  type SpreadPlan,
} from "./spread-policy.js";

interface AccountRow {
  id: string;
  user_id: string;
  broker_binding: string;
  halted: boolean;
  halt_reason: string;
  generation: number;
  snapshot: string;
  limits: string;
  reconciled_at: number;
  broker_id: string | null;
}
export interface OrderRow {
  id: string;
  account_id: string;
  intent_key: string;
  intent: string;
  state: OrderState;
  broker_order: string;
  reserved_paise: string;
  created_at: number;
  broker_id: string | null;
}

/** Provision a separate live control record, initially halted. This does not connect a broker
 * or grant permission to trade. Binding must uniquely identify the actual broker account.
 */
export async function createLiveAccount(
  store: Store,
  userId: string,
  brokerBinding: string,
  limits: RiskLimits,
  brokerId: string | null = null,
) {
  const id = randomUUID();
  if (!brokerBinding || brokerBinding.length > 200) {
    throw new Error("Broker account binding required");
  }
  await store.transaction((query) =>
    query(
      "INSERT INTO live_accounts(id,user_id,broker_binding,halt_reason,limits,broker_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        userId,
        brokerBinding,
        "Initial reconciliation and explicit resume required",
        JSON.stringify(riskLimitsSchema.parse(limits)),
        brokerId,
      ],
    ),
  );
  return id;
}

/** Append non-secret safety facts to the live execution audit. */
async function recordLiveEvent(
  query: Query,
  accountId: string,
  kind: string,
  detail: string,
) {
  await query(
    "INSERT INTO live_events(account_id,kind,detail,created_at) VALUES($1,$2,$3,$4)",
    [accountId, kind, detail, Date.now()],
  );
}

/** Validate identity and monotonic broker progress; a terminal order cannot become open again.
 * A broker cancellation may carry additional fills, but cumulative fills cannot decrease.
 */
function validateBrokerProgress(
  intent: OrderIntent,
  current: BrokerOrder | undefined,
  next: BrokerOrder,
) {
  brokerOrderSchema.parse(next);
  const transitions: Record<
    BrokerOrder["status"],
    ReadonlySet<BrokerOrder["status"]>
  > = {
    acknowledged: new Set([
      "acknowledged",
      "open",
      "partially_filled",
      "filled",
      "cancelled",
      "rejected",
    ]),
    open: new Set([
      "open",
      "partially_filled",
      "filled",
      "cancelled",
      "rejected",
    ]),
    partially_filled: new Set(["partially_filled", "filled", "cancelled"]),
    filled: new Set(["filled"]),
    cancelled: new Set(["cancelled"]),
    rejected: new Set(["rejected"]),
  };
  if (
    next.clientOrderKey !== intent.key ||
    next.instrument !== intent.instrument ||
    next.side !== intent.side ||
    next.quantity !== intent.quantity ||
    next.filledQuantity > next.quantity
  ) {
    throw new Error("Broker order identity mismatch");
  }
  if (next.status === "filled" && next.filledQuantity !== next.quantity) {
    throw new Error("Invalid filled quantity");
  }
  if (next.status === "rejected" && next.filledQuantity !== 0) {
    throw new Error("Rejected order has fills");
  }
  if (
    (["acknowledged", "open"].includes(next.status) &&
      next.filledQuantity !== 0) ||
    (next.status === "partially_filled" &&
      (next.filledQuantity === 0 || next.filledQuantity === next.quantity))
  ) {
    throw new Error("Order status contradicts fill quantity");
  }
  if (
    current &&
    (current.brokerOrderId !== next.brokerOrderId ||
      next.filledQuantity < current.filledQuantity ||
      !transitions[current.status].has(next.status))
  ) {
    throw new Error("Broker order state regressed");
  }
}

export class LiveExecutionService {
  /** Bind this service to one authenticated owner/account/adapter. No browser-supplied owner
   * ID may be used by a future route; use only the already-authenticated session identity.
   */
  constructor(
    private readonly store: Store,
    private readonly userId: string,
    private readonly accountId: string,
    private readonly adapter: ExecutionBrokerAdapter,
    private readonly deadlineMs = 1500,
    private readonly authorizeSubmission?: (query: Query) => Promise<void>,
    private readonly brokerId?: string,
  ) {
    if (deadlineMs < 1 || deadlineMs > 3000) {
      throw new Error("Broker deadline must be between 1 and 3000 ms");
    }
  }

  /** Acquire the shared DB gate and reject cross-account/adapter access before any broker call. */
  private async lockAccount(query: Query) {
    const account = (
      await query<AccountRow>(
        "SELECT * FROM live_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [this.accountId, this.userId],
      )
    )[0];
    if (
      !account ||
      account.broker_binding !== this.adapter.accountBinding ||
      (this.brokerId !== undefined && account.broker_id !== this.brokerId)
    ) {
      throw new Error("Live account unavailable");
    }
    return account;
  }

  /** Persistent kill latch, checked by both reservation and the final adapter dispatch gate. */
  private async latchHalt(query: Query, reason: string) {
    const changed = await query(
      "UPDATE live_accounts SET halted=TRUE,halt_reason=$2,generation=generation+1,reconciled_at=0 WHERE id=$1 AND (NOT halted OR halt_reason<>$2 OR reconciled_at<>0) RETURNING id",
      [this.accountId, reason],
    );
    if (changed.length) {
      await recordLiveEvent(query, this.accountId, "halt", reason);
    }
  }

  /** Read current state through the owner boundary; useful for a future risk dashboard. */
  public async status() {
    return this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      const orders = await query<OrderRow>(
        "SELECT * FROM live_orders WHERE account_id=$1 ORDER BY created_at",
        [this.accountId],
      );
      return {
        halted: account.halted,
        reason: account.halt_reason,
        reconciledAt: account.reconciled_at,
        orders,
      };
    });
  }

  /** Persist the currently active broker with an immutable intent before any broker I/O.
   * The settings row and broker row are locked in this transaction, so a concurrent active
   * selection either happens before this binding or after it—never halfway through it.
   */
  public async bindIntent(rawIntent: OrderIntent): Promise<OrderRow> {
    if (this.brokerId === undefined) {
      throw new Error("Durable broker identity is required");
    }
    const intent = orderIntentSchema.parse(rawIntent);
    return this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      await this.authorizeSubmission?.(query);
      const active = await resolveActiveBroker(query, this.userId, true);
      if (
        active.id !== this.brokerId ||
        active.accountBinding !== this.adapter.accountBinding
      ) {
        throw new Error(
          "Active broker changed before the order intent was bound",
        );
      }
      const [existing] = await query<OrderRow>(
        "SELECT * FROM live_orders WHERE account_id=$1 AND intent_key=$2",
        [this.accountId, intent.key],
      );
      if (existing) {
        if (
          existing.intent !== JSON.stringify(intent) ||
          existing.broker_id !== this.brokerId
        ) {
          throw new Error("Intent key already used for different content");
        }
        return existing;
      }
      if (account.halted) {
        throw new Error("Live account halted");
      }
      const [order] = await query<OrderRow>(
        "INSERT INTO live_orders(id,account_id,intent_key,intent,state,reserved_paise,created_at,broker_id) VALUES($1,$2,$3,$4,'bound',0,$5,$6) RETURNING *",
        [
          randomUUID(),
          this.accountId,
          intent.key,
          JSON.stringify(intent),
          Date.now(),
          this.brokerId,
        ],
      );
      await recordLiveEvent(query, this.accountId, "bound", order.id);
      return order;
    });
  }

  /** Risk-reserve a previously broker-bound intent after a fresh broker reconciliation. */
  public async reserveBoundIntent(orderId: string): Promise<OrderRow> {
    if (this.brokerId === undefined) {
      throw new Error("Durable broker identity is required");
    }
    return this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      await this.authorizeSubmission?.(query);
      const [order] = await query<OrderRow>(
        "SELECT * FROM live_orders WHERE id=$1 AND account_id=$2 FOR UPDATE",
        [orderId, this.accountId],
      );
      if (!order || order.broker_id !== this.brokerId) {
        throw new Error("Bound order intent is unavailable");
      }
      if (order.state === "reserved") {
        return order;
      }
      if (order.state !== "bound") {
        throw new Error("Bound order intent is no longer reservable");
      }
      if (
        account.halted ||
        Date.now() - account.reconciled_at > maximumSnapshotAgeMs
      ) {
        throw new Error("Live account halted or reconciliation stale");
      }
      const orders = await query<OrderRow>(
        "SELECT * FROM live_orders WHERE account_id=$1 AND id<>$2",
        [this.accountId, orderId],
      );
      const outstanding = orders.filter(
        (candidate) =>
          candidate.state !== "bound" && !terminalStates.has(candidate.state),
      );
      const outstandingUnits: Record<string, number> = {};
      for (const candidate of outstanding) {
        const request = orderIntentSchema.parse(JSON.parse(candidate.intent));
        outstandingUnits[request.instrument] =
          (outstandingUnits[request.instrument] || 0) + request.quantity;
      }
      const intent = orderIntentSchema.parse(JSON.parse(order.intent));
      const reserved = evaluateLiveRisk(intent, {
        snapshot: brokerSnapshotSchema.parse(JSON.parse(account.snapshot)),
        limits: riskLimitsSchema.parse(JSON.parse(account.limits)),
        reservedPaise: outstanding.reduce(
          (total, candidate) => total + Number(candidate.reserved_paise),
          0,
        ),
        outstandingUnits,
        ordersLastMinute: orders.filter(
          (candidate) => candidate.created_at > Date.now() - 60000,
        ).length,
        now: Date.now(),
      });
      const [updated] = await query<OrderRow>(
        "UPDATE live_orders SET state='reserved',reserved_paise=$2 WHERE id=$1 AND state='bound' RETURNING *",
        [orderId, reserved],
      );
      await recordLiveEvent(query, this.accountId, "reserved", order.id);
      return updated;
    });
  }

  /** Atomically risk-check and reserve capital. Reusing an intent key returns the same order,
   * never a second submission; reusing it with changed content is rejected.
   */
  public async reserveIntent(rawIntent: OrderIntent): Promise<OrderRow> {
    const intent = orderIntentSchema.parse(rawIntent);
    return this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      await this.authorizeSubmission?.(query);
      if (this.brokerId !== undefined) {
        const active = await resolveActiveBroker(query, this.userId, true);
        if (
          active.id !== this.brokerId ||
          active.accountBinding !== this.adapter.accountBinding
        ) {
          throw new Error(
            "Active broker changed before the order intent was reserved",
          );
        }
      }
      const orders = await query<OrderRow>(
        "SELECT * FROM live_orders WHERE account_id=$1",
        [this.accountId],
      );
      const existing = orders.find((order) => order.intent_key === intent.key);
      if (existing) {
        if (existing.intent !== JSON.stringify(intent)) {
          throw new Error("Intent key already used for different content");
        }
        return existing;
      }
      if (
        account.halted ||
        Date.now() - account.reconciled_at > maximumSnapshotAgeMs
      ) {
        throw new Error("Live account halted or reconciliation stale");
      }
      const outstanding = orders.filter(
        (order) => order.state !== "bound" && !terminalStates.has(order.state),
      );
      const outstandingUnits: Record<string, number> = {};
      for (const order of outstanding) {
        const request = JSON.parse(order.intent) as OrderIntent;
        outstandingUnits[request.instrument] =
          (outstandingUnits[request.instrument] || 0) + request.quantity;
      }
      const reserved = evaluateLiveRisk(intent, {
        snapshot: brokerSnapshotSchema.parse(JSON.parse(account.snapshot)),
        limits: riskLimitsSchema.parse(JSON.parse(account.limits)),
        reservedPaise: outstanding.reduce(
          (total, order) => total + Number(order.reserved_paise),
          0,
        ),
        outstandingUnits,
        ordersLastMinute: orders.filter(
          (order) => order.created_at > Date.now() - 60000,
        ).length,
        now: Date.now(),
      });
      const order = (
        await query<OrderRow>(
          "INSERT INTO live_orders(id,account_id,intent_key,intent,state,reserved_paise,created_at,broker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            randomUUID(),
            this.accountId,
            intent.key,
            JSON.stringify(intent),
            "reserved",
            reserved,
            Date.now(),
            this.brokerId ?? null,
          ],
        )
      )[0];
      await recordLiveEvent(query, this.accountId, "reserved", order.id);
      return order;
    });
  }

  /** Dispatch each intent at most once from this database. Commit SUBMITTING first so a crash
   * cannot erase evidence of a possible external side effect. Never retry UNKNOWN/SUBMITTING.
   * No modify API exists: replacements need a separately approved intent after confirmed cancel.
   */
  public async submitReservedOrder(orderId: string): Promise<OrderRow> {
    const claimed = await this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      await this.authorizeSubmission?.(query);
      const order = (
        await query<OrderRow>(
          "SELECT * FROM live_orders WHERE id=$1 AND account_id=$2",
          [orderId, this.accountId],
        )
      )[0];
      if (!order) {
        throw new Error("Order unavailable");
      }
      if (this.brokerId !== undefined && order.broker_id !== this.brokerId) {
        throw new Error("Order belongs to another execution broker");
      }
      if (order.state !== "reserved") {
        return false;
      }
      if (account.halted) {
        throw new Error("Live account halted");
      }
      await query("UPDATE live_orders SET state='submitting' WHERE id=$1", [
        orderId,
      ]);
      return true;
    });
    if (!claimed) {
      return (await this.status()).orders.find(
        (order) => order.id === orderId,
      )!;
    }
    try {
      const submitted = await this.store.transaction(async (query) => {
        const account = await this.lockAccount(query);
        const order = (
          await query<OrderRow>(
            "SELECT * FROM live_orders WHERE id=$1 AND account_id=$2",
            [orderId, this.accountId],
          )
        )[0];
        if (this.brokerId !== undefined && order.broker_id !== this.brokerId) {
          throw new Error("Order belongs to another execution broker");
        }
        // The DB gate remains held across bounded I/O, so a committed kill cannot be bypassed
        // by a worker that cached an earlier permission. Already-in-flight calls cannot be unsent.
        if (
          account.halted ||
          Date.now() - account.reconciled_at > maximumSnapshotAgeMs ||
          order.state !== "submitting"
        ) {
          await query(
            "UPDATE live_orders SET state='blocked' WHERE id=$1 AND state='submitting'",
            [orderId],
          );
          await this.latchHalt(query, "Dispatch blocked by live safety gate");
        } else {
          let dispatchStarted = false;
          try {
            await this.authorizeSubmission?.(query);
            const intent = orderIntentSchema.parse(JSON.parse(order.intent));
            const snapshot = brokerSnapshotSchema.parse(
              JSON.parse(account.snapshot),
            );
            // Reservations survive time passing; re-evaluate against current positions/funds
            // before dispatch, excluding only this already-reserved intent from pending totals.
            const otherOrders = await query<OrderRow>(
              "SELECT * FROM live_orders WHERE account_id=$1 AND id<>$2",
              [this.accountId, orderId],
            );
            const otherPending = otherOrders.filter(
              (order) => !terminalStates.has(order.state),
            );
            const outstandingUnits: Record<string, number> = {};
            for (const pending of otherPending) {
              const request = orderIntentSchema.parse(
                JSON.parse(pending.intent),
              );
              outstandingUnits[request.instrument] =
                (outstandingUnits[request.instrument] || 0) + request.quantity;
            }
            evaluateLiveRisk(intent, {
              snapshot,
              limits: riskLimitsSchema.parse(JSON.parse(account.limits)),
              reservedPaise: otherPending.reduce(
                (sum, order) => sum + Number(order.reserved_paise),
                0,
              ),
              outstandingUnits,
              ordersLastMinute: otherOrders.filter(
                (order) => order.created_at > Date.now() - 60000,
              ).length,
              now: Date.now(),
            });
            if (
              !snapshot.sessionHealthy ||
              Date.now() - snapshot.capturedAt > maximumSnapshotAgeMs
            ) {
              throw new Error("Session state stale");
            }
            const probe = brokerSnapshotSchema.parse(
              await withBrokerDeadline(
                (signal) => this.adapter.getSnapshot(signal),
                10000,
              ),
            );
            // Require a fresh active health check at the adapter boundary, not just a worker flag.
            // Any changed books/funds must go through reconciliation before another submission.
            const comparable = (value: BrokerSnapshot) =>
              JSON.stringify({
                orders: value.orders,
                positions: value.positions,
                fundsBasis: value.fundsBasis,
                cashBalancePaise: value.cashBalancePaise,
              });
            if (
              !probe.sessionHealthy ||
              !probe.complete ||
              Date.now() - probe.capturedAt > maximumSnapshotAgeMs ||
              probe.capturedAt > Date.now() ||
              comparable(probe) !== comparable(snapshot)
            ) {
              throw new Error("Broker state changed before dispatch");
            }
            // Mark-to-market values can change between probes without changing the books.
            // Recheck buying power, loss and exposure against the NEW values, not cached ones.
            evaluateLiveRisk(intent, {
              snapshot: probe,
              limits: riskLimitsSchema.parse(JSON.parse(account.limits)),
              reservedPaise: otherPending.reduce(
                (sum, pending) => sum + Number(pending.reserved_paise),
                0,
              ),
              outstandingUnits,
              ordersLastMinute: otherOrders.filter(
                (o) => o.created_at > Date.now() - 60000,
              ).length,
              now: Date.now(),
            });
            await this.authorizeSubmission?.(query);
            dispatchStarted = true;
            const ack = await withBrokerDeadline(
              (signal) => this.adapter.placeOrder(intent, signal),
              this.deadlineMs,
            );
            validateBrokerProgress(intent, undefined, ack);
            await query(
              "UPDATE live_orders SET state=$2,broker_order=$3 WHERE id=$1",
              [orderId, ack.status, JSON.stringify(ack)],
            );
            // Funds/positions must be refreshed after EVERY dispatch, even a quick fill.
            await query(
              "UPDATE live_accounts SET reconciled_at=0 WHERE id=$1",
              [this.accountId],
            );
          } catch (error) {
            const state = !dispatchStarted
              ? "blocked"
              : error instanceof DefinitiveOrderRejection
                ? "rejected"
                : "unknown";
            await query("UPDATE live_orders SET state=$2 WHERE id=$1", [
              orderId,
              state,
            ]);
            await this.latchHalt(
              query,
              state === "unknown"
                ? "Submission outcome unknown; reconcile before any new order"
                : state === "blocked"
                  ? "Pre-dispatch session/state check failed"
                  : "Broker rejected submission",
            );
          }
        }
        await recordLiveEvent(query, this.accountId, "submission", orderId);
        return (
          await query<OrderRow>("SELECT * FROM live_orders WHERE id=$1", [
            orderId,
          ])
        )[0];
      });
      if (["unknown", "blocked", "rejected"].includes(submitted.state)) {
        await this.cancelRestingOrders();
      }
      return submitted;
    } catch (error) {
      // If persistence fails after broker acceptance, the precommitted SUBMITTING row survives.
      // Best effort halt; failed DB access itself prevents all subsequent dispatches.
      await this.store
        .transaction(async (query) => {
          await this.lockAccount(query);
          await this.latchHalt(
            query,
            "Submission persistence failure; reconciliation required",
          );
        })
        .catch(() => {});
      throw error;
    }
  }

  /** Permanently retire a broker-bound intent that failed before broker dispatch. */
  public async blockReservedOrder(orderId: string, reason: string) {
    return this.store.transaction(async (query) => {
      await this.lockAccount(query);
      const rows = await query<OrderRow>(
        "UPDATE live_orders SET state='blocked' WHERE id=$1 AND account_id=$2 AND state IN ('bound','reserved') AND ($3::varchar IS NULL OR broker_id=$3) RETURNING *",
        [orderId, this.accountId, this.brokerId ?? null],
      );
      if (rows.length) {
        await recordLiveEvent(query, this.accountId, "blocked", reason);
      }
      return rows[0] ?? null;
    });
  }

  /** Latch first, then attempt cancellation. A cancel acknowledgement is NOT proof of cancel;
   * only a later snapshot may mark it terminal. Retry polls keep cancelling visible rests.
   * Existing positions are NOT flattened automatically by a kill switch.
   */
  public async haltAndCancel(reason = "Operator kill switch") {
    await this.store.transaction(async (query) => {
      await this.lockAccount(query);
      await this.latchHalt(query, reason);
      await query(
        "UPDATE live_orders SET state='blocked' WHERE account_id=$1 AND state IN ('bound','reserved')",
        [this.accountId],
      );
    });
    return this.cancelRestingOrders();
  }

  /** Cancellation is a risk-reduction operation permitted while halted, but still account-bound.
   * Failed/unseen cancellations remain unresolved; never label an unreachable broker safe.
   */
  private async cancelRestingOrders() {
    await this.store.transaction((query) => this.lockAccount(query));
    const unresolved: string[] = [];
    try {
      const snapshot = this.adapter.getCancellationOrders
        ? {
            orders: await withBrokerDeadline(
              (signal) => this.adapter.getCancellationOrders!(signal),
              10000,
            ),
            complete: true,
            sessionHealthy: true,
          }
        : brokerSnapshotSchema.parse(
            await withBrokerDeadline(
              (signal) => this.adapter.getSnapshot(signal),
              10000,
            ),
          );
      for (const order of snapshot.orders.filter(
        (order) => !terminalStates.has(order.status),
      )) {
        try {
          await withBrokerDeadline(
            (signal) => this.adapter.cancelOrder(order.brokerOrderId, signal),
            this.deadlineMs,
          );
        } catch {
          unresolved.push(order.brokerOrderId);
        }
      }
      if (!snapshot.complete || !snapshot.sessionHealthy) {
        unresolved.push("broker-state-unavailable");
      }
    } catch {
      unresolved.push("broker-state-unavailable");
    }
    await this.store.transaction((query) =>
      recordLiveEvent(
        query,
        this.accountId,
        "cancel_requested",
        unresolved.length
          ? "Cancellation remains unresolved"
          : "Awaiting terminal broker confirmation",
      ),
    );
    return { halted: true, cancellationConfirmed: false, unresolved };
  }

  /** Broker books are truth. Refresh acknowledged orders, detect positions/funds drift, and
   * latch failures. An absent unknown order stays UNKNOWN even after many empty snapshots.
   * A fresh deployment can establish a baseline only with a flat account and empty order book.
   */
  public async reconcile() {
    await this.store.transaction((query) => this.lockAccount(query));
    let snapshot: BrokerSnapshot;
    try {
      snapshot = brokerSnapshotSchema.parse(
        await withBrokerDeadline(
          (signal) => this.adapter.getSnapshot(signal),
          10000,
        ),
      );
      if (
        !snapshot.complete ||
        !snapshot.sessionHealthy ||
        Date.now() - snapshot.capturedAt > maximumSnapshotAgeMs ||
        snapshot.capturedAt > Date.now()
      ) {
        throw new Error("Stale or incomplete broker state");
      }
    } catch {
      await this.haltAndCancel(
        "Broker session stale, unavailable or incomplete",
      );
      return { clean: false, reason: "Broker state unavailable" };
    }
    const result = await this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      const orders = await query<OrderRow>(
        "SELECT * FROM live_orders WHERE account_id=$1",
        [this.accountId],
      );
      let reason = "";
      const previous = account.snapshot
        ? brokerSnapshotSchema.parse(JSON.parse(account.snapshot))
        : undefined;
      if (previous && snapshot.capturedAt < previous.capturedAt) {
        reason = "Out-of-order broker snapshot";
      }
      const ids = new Set<string>(),
        keys = new Set<string>();
      const expectedPositions: Record<string, number> = {};
      for (const observed of snapshot.orders) {
        if (
          ids.has(observed.brokerOrderId) ||
          keys.has(observed.clientOrderKey)
        ) {
          reason = "Duplicate broker order correlation";
        }
        ids.add(observed.brokerOrderId);
        keys.add(observed.clientOrderKey);
        const local = orders.find(
          (order) => order.intent_key === observed.clientOrderKey,
        );
        if (
          !local ||
          local.state === "reserved" ||
          local.state === "blocked" ||
          (local.state === "rejected" && !local.broker_order)
        ) {
          reason = "Untracked broker order";
          continue;
        }
        try {
          validateBrokerProgress(
            JSON.parse(local.intent),
            local.broker_order ? JSON.parse(local.broker_order) : undefined,
            observed,
          );
          await query(
            "UPDATE live_orders SET state=$2,broker_order=$3 WHERE id=$1",
            [local.id, observed.status, JSON.stringify(observed)],
          );
        } catch {
          reason = "Broker order identity or state drift";
        }
        expectedPositions[observed.instrument] =
          (expectedPositions[observed.instrument] || 0) +
          (observed.side === "buy" ? 1 : -1) * observed.filledQuantity;
      }
      for (const order of orders) {
        if (
          !keys.has(order.intent_key) &&
          [
            "submitting",
            "unknown",
            "acknowledged",
            "open",
            "partially_filled",
            "filled",
            "cancelled",
          ].includes(order.state)
        ) {
          reason =
            "Missing or unresolved broker order; no resubmission allowed";
          if (order.state === "submitting") {
            await query("UPDATE live_orders SET state='unknown' WHERE id=$1", [
              order.id,
            ]);
          }
        }
      }
      for (const instrument of new Set([
        ...Object.keys(expectedPositions),
        ...Object.keys(snapshot.positions),
      ])) {
        if (
          (expectedPositions[instrument] || 0) !==
          (snapshot.positions[instrument] || 0)
        ) {
          reason = "Broker position drift";
        }
      }
      const limits = riskLimitsSchema.parse(JSON.parse(account.limits));
      if (previous && previous.fundsBasis !== snapshot.fundsBasis) {
        reason = "Broker accounting basis changed";
      }
      if (previous && snapshot.fundsBasis === "cash-ledger") {
        const previousCash = previous.orders.reduce(
          (sum, order) => sum + (order.cashDeltaPaise ?? 0),
          0,
        );
        const currentCash = snapshot.orders.reduce(
          (sum, order) => sum + (order.cashDeltaPaise ?? 0),
          0,
        );
        if (
          Math.abs(
            snapshot.cashBalancePaise! -
              previous.cashBalancePaise! -
              (currentCash - previousCash),
          ) > limits.fundsDriftTolerancePaise
        ) {
          reason = "Broker funds drift";
        }
      } else if (
        !previous &&
        (snapshot.orders.length ||
          Object.values(snapshot.positions).some((quantity) => quantity !== 0))
      ) {
        reason = "Initial broker baseline is not flat";
      }
      if (snapshot.dailyPnlPaise <= -limits.maxDailyLossPaise) {
        reason = "Daily loss limit reached";
      }
      if (
        snapshot.grossExposurePaise > limits.maxGrossExposurePaise ||
        Object.values(snapshot.positions).some(
          (quantity) => Math.abs(quantity) > limits.maxPositionUnits,
        )
      ) {
        reason = "Post-trade exposure limit reached";
      }
      // Preserve the last good baseline on drift; repeated polling cannot silently normalize it.
      if (reason) {
        await this.latchHalt(query, reason);
      } else {
        await query(
          "UPDATE live_accounts SET snapshot=$2,reconciled_at=$3 WHERE id=$1",
          [this.accountId, JSON.stringify(snapshot), Date.now()],
        );
      }
      // Unchanged polling must not append an audit row every second indefinitely.
      if (
        (reason && account.halt_reason !== reason) ||
        (!reason && account.reconciled_at === 0)
      ) {
        await recordLiveEvent(
          query,
          this.accountId,
          "reconciliation",
          reason || "Matched broker state",
        );
      }
      return {
        clean: !reason,
        reason,
        halted: account.halted || Boolean(reason),
      };
    });
    if (result.halted) {
      await this.cancelRestingOrders();
    }
    return result;
  }

  /** Explicit resume only after a fresh successful reconciliation. It cannot clear unknown
   * outcomes, lingering resting orders after a kill, or unresolved multi-leg exposure.
   */
  public async resumeAfterReconciliation() {
    await this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      if (
        !account.snapshot ||
        Date.now() - account.reconciled_at > maximumSnapshotAgeMs
      ) {
        throw new Error("Fresh reconciliation required");
      }
      const unresolved = await query(
        "SELECT id FROM live_orders WHERE account_id=$1 AND state IN ('submitting','unknown','acknowledged','open','partially_filled')",
        [this.accountId],
      );
      const spreads = await query(
        "SELECT id FROM live_spreads WHERE account_id=$1 AND state='unwind_required'",
        [this.accountId],
      );
      if (unresolved.length || spreads.length) {
        throw new Error("Unresolved live exposure requires operator review");
      }
      await query(
        "UPDATE live_accounts SET halted=FALSE,halt_reason='' WHERE id=$1",
        [this.accountId],
      );
      await recordLiveEvent(
        query,
        this.accountId,
        "resume",
        "Explicit resume after reconciliation",
      );
    });
  }

  /** Store a strategy's explicit hedge-first/slippage/orphan policy before either leg is sent.
   * Generated intent keys bind each leg to this durable plan, preventing duplicate leg calls.
   */
  public async createHedgeFirstSpread(rawPlan: Omit<SpreadPlan, "createdAt">) {
    const id = randomUUID();
    const plan = spreadPlanSchema.parse({
      ...rawPlan,
      hedge: { ...rawPlan.hedge, key: `${id}:hedge` },
      exposure: { ...rawPlan.exposure, key: `${id}:exposure` },
      createdAt: Date.now(),
    });
    await this.store.transaction(async (query) => {
      const account = await this.lockAccount(query);
      if (this.brokerId !== undefined) {
        const active = await resolveActiveBroker(query, this.userId, true);
        if (
          active.id !== this.brokerId ||
          active.accountBinding !== this.adapter.accountBinding
        ) {
          throw new Error(
            "Active broker changed before the spread plan was bound",
          );
        }
      }
      if (account.halted) {
        throw new Error("Live account halted");
      }
      await query(
        "INSERT INTO live_spreads(id,account_id,plan,state,broker_id) VALUES($1,$2,$3,'hedge_pending',$4)",
        [id, this.accountId, JSON.stringify(plan), this.brokerId ?? null],
      );
    });
    return id;
  }

  /** Progress at most one leg per call. Call reconciliation between steps. Full hedge fill is
   * mandatory before exposure; partial/rejected/unknown legs never count as protection.
   * Restart recovery does not automatically call this method or resume a spread.
   */
  public async advanceHedgeFirstSpread(planId: string) {
    const record = await this.store.transaction(async (query) => {
      await this.lockAccount(query);
      const row = (
        await query<{ plan: string; state: string; broker_id: string | null }>(
          "SELECT plan,state,broker_id FROM live_spreads WHERE id=$1 AND account_id=$2",
          [planId, this.accountId],
        )
      )[0];
      if (
        !row ||
        (this.brokerId !== undefined && row.broker_id !== this.brokerId)
      ) {
        throw new Error("Spread unavailable");
      }
      return row;
    });
    if (["complete", "unwind_required"].includes(record.state)) {
      return record.state;
    }
    const plan = spreadPlanSchema.parse(JSON.parse(record.plan));
    const orders = (await this.status()).orders;
    const hedge = orders.find((order) => order.intent_key === plan.hedge.key),
      exposure = orders.find((order) => order.intent_key === plan.exposure.key);
    const saveState = async (state: string, detail = "") => {
      await this.store.transaction(async (query) => {
        await this.lockAccount(query);
        await query(
          "UPDATE live_spreads SET state=$3,detail=$4 WHERE id=$1 AND account_id=$2 AND state NOT IN ('complete','unwind_required')",
          [planId, this.accountId, state, detail],
        );
      });
      return state;
    };
    const requireUnwind = async (reason: string) => {
      await this.haltAndCancel(reason);
      // Refresh known fills after cancel attempts; cancels can race fills.
      await this.reconcile();
      const latest = (await this.status()).orders.filter((order) =>
        [plan.hedge.key, plan.exposure.key].includes(order.intent_key),
      );
      return saveState(
        "unwind_required",
        JSON.stringify({
          reason,
          knownFills: describeOrphanExposure(
            latest
              .filter((order) => order.broker_order)
              .map((order) => JSON.parse(order.broker_order)),
          ),
          brokerVerificationRequired: true,
        }),
      );
    };
    if (exposure?.state === "filled" && hedge?.state === "filled") {
      return saveState("complete");
    }
    if (Date.now() - plan.createdAt > plan.legDeadlineMs) {
      return requireUnwind("Multi-leg deadline exceeded");
    }
    if (!hedge) {
      const reserved = await this.reserveIntent(plan.hedge);
      await this.submitReservedOrder(reserved.id);
      return saveState("hedge_pending");
    }
    if (["unknown", "blocked", "rejected", "cancelled"].includes(hedge.state)) {
      return requireUnwind("Hedge failed or remains uncertain");
    }
    if (hedge.state !== "filled") {
      return "hedge_pending";
    }
    if (exposure) {
      if (
        ["unknown", "blocked", "rejected", "cancelled"].includes(exposure.state)
      ) {
        return requireUnwind("Exposure leg failed or remains uncertain");
      }
      return "exposure_pending";
    }
    try {
      // Account was authenticated above; no execution is possible through this read-only quote.
      const quote = await withBrokerDeadline(
        (signal) =>
          this.adapter.getQuote(
            plan.exposure.instrument,
            plan.exposure.side,
            signal,
          ),
        this.deadlineMs,
      );
      const limitPaise = boundedExposureLimit(plan, quote, Date.now());
      const reserved = await this.reserveIntent({
        ...plan.exposure,
        limitPaise,
      });
      await this.submitReservedOrder(reserved.id);
      return saveState("exposure_pending");
    } catch {
      return requireUnwind("Exposure leg risk, quote or slippage check failed");
    }
  }

  /** A restart always halts first. Polling is serial (no overlapping reconciliation jobs),
   * and never auto-resumes. Research workers do not import or launch this loop.
   */
  public async runReconciliationLoop(signal: AbortSignal, intervalMs = 1000) {
    if (intervalMs < 100 || intervalMs > 2000) {
      throw new Error("Polling interval must be 100–2000 ms");
    }
    await this.haltAndCancel(
      "Live worker restarted; reconciliation and explicit resume required",
    );
    while (!signal.aborted) {
      await this.reconcile();
      if (signal.aborted) {
        break;
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, intervalMs);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
