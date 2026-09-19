"use client";

/** Read-only live order history; execution remains behind the dedicated confirmation and risk controls. */
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { OrderRecordsTable } from "./order-records-table";

/** Render OMS records, preserving unknown quantities and distinguishing limit prices from actual fills. */
export function LiveOrdersScreen() {
  const { snapshot, loading, error, onRefresh } = useLiveOrders();
  return (
    <section className="panel" aria-label="Live orders" aria-busy={loading}>
      <div className="panel-heading">
        <div>
          <h3>Live orders & fills</h3>
          <p>
            App-managed orders only · filled units are broker acknowledgements,
            not a full exchange trade book.
          </p>
        </div>
        <Button variant="secondary" disabled={loading} onClick={onRefresh}>
          Refresh orders
        </Button>
      </div>
      {loading && <p role="status">Loading live orders…</p>}
      {error && (
        <p role="alert">
          {error} Previously loaded records, if shown, may be stale.
        </p>
      )}
      {snapshot?.reason && <p role="status">{snapshot.reason}</p>}
      {snapshot && !Array.isArray(snapshot.orders) && (
        <p>
          Order history is unavailable. Open Live positions to review execution
          readiness.
        </p>
      )}
      {snapshot?.orders?.length === 0 && (
        <p>No app-managed live orders recorded.</p>
      )}
      {snapshot?.orders && (
        <OrderRecordsTable
          records={snapshot.orders.map((order) => ({
            id: order.id,
            instrument: order.intent.instrument,
            side: order.intent.side,
            quantity: order.intent.quantity,
            limit: order.intent.limitPaise / 100,
            filled: order.brokerOrder?.filledQuantity ?? null,
            state: order.state,
            brokerOrderId: order.brokerOrder?.brokerOrderId,
          }))}
        />
      )}
    </section>
  );
}

/** Broker-neutral view of durable, app-managed live orders. Research jobs are never used as a fallback. */

export interface LiveOrderRecord {
  id: string;
  state: string;
  intent: {
    instrument: string;
    side: "buy" | "sell";
    quantity: number;
    limitPaise: number;
  };
  brokerOrder?: { brokerOrderId: string; filledQuantity: number } | null;
}

export interface LiveOrdersSnapshot {
  enabled: boolean;
  reason?: string;
  orders?: LiveOrderRecord[];
}

/** Read the existing OMS snapshot once; this GET cannot arm, reconcile, submit, or cancel an order. */
export async function loadLiveOrders(): Promise<LiveOrdersSnapshot> {
  return requestApiJson("/live/status");
}

/** Own the read-only order request lifecycle separately from order presentation and execution controls. */

/** Fetch on entry or explicit refresh, never on an automatic timer or from a simulated ledger. */
export function useLiveOrders() {
  const [snapshot, setSnapshot] = useState<LiveOrdersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);

  /** Fence stale responses after refresh/unmount and surface failed reads without reporting an empty book. */
  const onRefresh = useCallback(async () => {
    const requestId = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await loadLiveOrders();
      if (requestId === generation.current) {
        setSnapshot(next);
      }
    } catch (cause) {
      if (requestId === generation.current) {
        setError(
          cause instanceof Error ? cause.message : "Live orders unavailable.",
        );
      }
    } finally {
      if (requestId === generation.current) {
        setLoading(false);
      }
    }
  }, []);

  /** Start one read when the screen mounts; invalidate all pending reads when the account/screen changes. */
  useEffect(() => {
    void onRefresh(); // The callback handles all rejections and never retries mutations.
    const requestGeneration = generation;
    /** Prevent a late request from updating a departed account's view. */
    return () => {
      requestGeneration.current++;
    };
  }, [onRefresh]);

  return { snapshot, loading, error, onRefresh };
}
