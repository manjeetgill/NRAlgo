"use client";

/** Read-only live order history; execution remains behind the dedicated confirmation and risk controls. */
import { Button } from "@/components/ui/button";
import { useLiveOrders } from "./use-live-orders";
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
          mode="live"
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
