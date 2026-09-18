"use client";

/** Read-only live order history; execution remains behind the dedicated confirmation and risk controls. */
import { Button } from "@/components/ui/button";
import { useLiveOrders } from "./use-live-orders";

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
          Order history is unavailable. Open Live trading to review execution
          readiness.
        </p>
      )}
      {snapshot?.orders?.length === 0 && (
        <p>No app-managed live orders recorded.</p>
      )}
      {Boolean(snapshot?.orders?.length) && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Side</th>
                <th>Units</th>
                <th>Limit price</th>
                <th>Filled units</th>
                <th>Status</th>
                <th>Broker order</th>
              </tr>
            </thead>
            <tbody>
              {snapshot?.orders?.map(
                /** Keep durable intent IDs as row keys; missing broker acknowledgements stay unknown. */
                (order) => (
                  <tr key={order.id}>
                    <td>{order.intent.instrument}</td>
                    <td>{order.intent.side.toUpperCase()}</td>
                    <td>{order.intent.quantity}</td>
                    <td>
                      {(order.intent.limitPaise / 100).toLocaleString("en-IN", {
                        style: "currency",
                        currency: "INR",
                      })}
                    </td>
                    <td>{order.brokerOrder?.filledQuantity ?? "—"}</td>
                    <td>{order.state}</td>
                    <td>{order.brokerOrder?.brokerOrderId ?? "—"}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
