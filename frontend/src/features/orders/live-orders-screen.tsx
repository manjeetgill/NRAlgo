"use client";

/** Read-only live order history; execution remains behind the dedicated confirmation and risk controls. */
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { OrderRecordsTable } from "./order-records-table";
import styles from "./live-orders-screen.module.css";

/** Render OMS records, preserving unknown quantities and distinguishing limit prices from actual fills. */
export function LiveOrdersScreen() {
  const { snapshot, loading, error, onRefresh } = useLiveOrders();
  return (
    <section
      className="screen-stack"
      aria-label="Live orders"
      aria-busy={loading}
    >
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Live orders &amp; fills</CardTitle>
            <CardDescription>
              App-managed orders only · filled units are broker
              acknowledgements, not a full exchange trade book.
            </CardDescription>
          </div>
          <Button variant="secondary" disabled={loading} onClick={onRefresh}>
            Refresh orders
          </Button>
        </CardHeader>
        {error && (
          <p role="alert" className={styles.alert}>
            {error} Previously loaded records, if shown, may be stale.
          </p>
        )}
        {/* Loading shows a skeleton; an error above never hides an already-loaded, possibly
         * stale snapshot, since useLiveOrders intentionally retains the last known records. */}
        <AsyncBoundary status={loading ? "loading" : "success"}>
          {snapshot?.reason && (
            <p role="status" className={styles.status}>
              {snapshot.reason}
            </p>
          )}
          {snapshot && !Array.isArray(snapshot.orders) && (
            <p className={styles.note}>
              Order history is unavailable.{" "}
              <a href="#/live-positions">Open Live positions</a> to review
              execution readiness.
            </p>
          )}
          {snapshot?.orders?.length === 0 && (
            <p className={styles.note}>No app-managed live orders recorded.</p>
          )}
          {snapshot?.orders && (
            <OrderRecordsTable
              brokerLabel={
                snapshot.provider === "kotak"
                  ? "Kotak Neo"
                  : snapshot.provider === "zerodha"
                    ? "Zerodha Kite"
                    : undefined
              }
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
        </AsyncBoundary>
      </Card>
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
  provider?: string;
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
