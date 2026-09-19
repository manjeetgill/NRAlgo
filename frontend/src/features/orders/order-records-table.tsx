"use client";
/** Broker order records presentation. */
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatInr } from "@/lib/format";
import { downloadText, encodeCsv } from "@/lib/download";
export interface OrderRecord {
  id: string;
  instrument: string;
  side: string;
  quantity: number;
  limit: number;
  filled: number | null;
  state: string;
  brokerOrderId?: string;
  fillPrice?: number | null;
  createdAt?: number;
}
/** Filter/export the same records; a native dialog preserves keyboard focus and never submits an order. */
export function OrderRecordsTable({ records }: { records: OrderRecord[] }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<OrderRecord | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  /** Search is a local projection and cannot change the broker account. */
  const filtered = useMemo(
    () =>
      records.filter(
        (order) =>
          (status === "all" || order.state === status) &&
          `${order.id} ${order.brokerOrderId ?? ""} ${order.instrument} Kotak`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [records, search, status],
  );
  /** Export only the filtered book; unknown values remain empty and text cannot become a spreadsheet formula. */
  function exportRecords() {
    downloadText(
      "live-orders.csv",
      encodeCsv([
        [
          "Order ID",
          "Mode",
          "Broker",
          "Instrument",
          "Side",
          "Units",
          "Limit INR",
          "Filled units",
          "Status",
          "Broker order ID",
        ],
        ...filtered.map((order) => [
          order.id,
          "live",
          "Kotak",
          order.instrument,
          order.side,
          order.quantity,
          order.limit,
          order.filled,
          order.state,
          order.brokerOrderId,
        ]),
      ]),
      "text/csv",
    );
  }
  return (
    <>
      <div className="screen-toolbar">
        <label>
          Search orders
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Instrument, order or broker"
          />
        </label>
        <label>
          Order status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            {[...new Set(records.map((order) => order.state))]
              .sort()
              .map((state) => (
                <option key={state}>{state}</option>
              ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={!filtered.length}
          onClick={exportRecords}
        >
          Export CSV
        </Button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Mode / broker</th>
              <th>Instrument</th>
              <th>Side</th>
              <th>Units</th>
              <th>Filled units</th>
              <th>Limit</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((order) => (
              <tr key={order.id}>
                <td>live · Kotak</td>
                <td>
                  {order.instrument}
                  <small>{order.id}</small>
                </td>
                <td>{order.side}</td>
                <td>{order.quantity}</td>
                <td>{order.filled ?? "—"}</td>
                <td>{formatInr(order.limit)}</td>
                <td>
                  <span className="badge">{order.state}</span>
                </td>
                <td>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelected(order);
                      dialog.current?.showModal();
                    }}
                  >
                    Details
                  </Button>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8}>No orders match this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {filtered.length} of {records.length} records · App-managed OMS only;
        not the complete broker trade book.
      </p>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        aria-labelledby="order-detail-title"
      >
        <div className="screen-toolbar">
          <h2 id="order-detail-title">Order details</h2>
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Close details
          </Button>
        </div>
        {selected && (
          <dl>
            <dt>Order ID</dt>
            <dd>{selected.id}</dd>
            <dt>Account domain</dt>
            <dd>live · Kotak</dd>
            <dt>Instrument</dt>
            <dd>{selected.instrument}</dd>
            <dt>Requested / filled units</dt>
            <dd>
              {selected.quantity} / {selected.filled ?? "Unknown"}
            </dd>
            <dt>Limit / fill price</dt>
            <dd>
              {formatInr(selected.limit)} /{" "}
              {selected.fillPrice === null || selected.fillPrice === undefined
                ? "Unavailable"
                : formatInr(selected.fillPrice)}
            </dd>
            <dt>State</dt>
            <dd>{selected.state}</dd>
            <dt>Broker order ID</dt>
            <dd>{selected.brokerOrderId ?? "Unavailable"}</dd>
          </dl>
        )}
        <p>
          Only recorded facts are shown. A complete exchange event timeline is
          not available here.
        </p>
      </dialog>
    </>
  );
}
