"use client";
/** Broker order records presentation. */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { formatInr } from "@/lib/format";
import { downloadText, encodeCsv } from "@/lib/download";
import styles from "./order-records-table.module.css";

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

/** Broker order lifecycle values persisted by the OMS; purely presentational tones. */
const ORDER_STATE_TONE: Record<string, BadgeTone> = {
  filled: "success",
  acknowledged: "success",
  open: "info",
  partially_filled: "info",
  reserved: "neutral",
  bound: "neutral",
  submitting: "warning",
  unknown: "warning",
  blocked: "danger",
  rejected: "danger",
  cancelled: "neutral",
};

/** Filter/export the same records; a controlled dialog preserves keyboard focus and never submits an order. */
export function OrderRecordsTable({
  records,
  brokerLabel = "Broker not reported",
}: {
  records: OrderRecord[];
  brokerLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<OrderRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  /** Search is a local projection and cannot change the broker account. */
  const filtered = useMemo(
    () =>
      records.filter(
        (order) =>
          (status === "all" || order.state === status) &&
          `${order.id} ${order.brokerOrderId ?? ""} ${order.instrument} ${brokerLabel}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [records, search, status, brokerLabel],
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
          brokerLabel,
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
  const columns: DataTableColumn<OrderRecord>[] = [
    {
      key: "mode",
      header: "Mode / broker",
      render: () => `live · ${brokerLabel}`,
    },
    {
      key: "instrument",
      header: "Instrument",
      sortValue: (order) => order.instrument,
      render: (order) => (
        <>
          {order.instrument}
          <small className={styles.orderId}>{order.id}</small>
        </>
      ),
    },
    { key: "side", header: "Side", render: (order) => order.side },
    {
      key: "quantity",
      header: "Units",
      align: "right",
      sortValue: (order) => order.quantity,
      render: (order) => <span className={styles.mono}>{order.quantity}</span>,
    },
    {
      key: "filled",
      header: "Filled units",
      align: "right",
      sortValue: (order) => order.filled ?? -1,
      render: (order) => (
        <span className={styles.mono}>{order.filled ?? "—"}</span>
      ),
    },
    {
      key: "limit",
      header: "Limit",
      align: "right",
      sortValue: (order) => order.limit,
      render: (order) => (
        <span className={styles.mono}>{formatInr(order.limit)}</span>
      ),
    },
    {
      key: "state",
      header: "Status",
      render: (order) => (
        <Badge tone={ORDER_STATE_TONE[order.state] ?? "neutral"}>
          {order.state}
        </Badge>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (order) => (
        <Button
          variant="ghost"
          onClick={() => {
            setSelected(order);
            setDetailOpen(true);
          }}
        >
          Details
        </Button>
      ),
    },
  ];
  return (
    <>
      <div className="screen-toolbar">
        <Field label="Search orders" htmlFor="order-search">
          <Input
            id="order-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Instrument, order or broker"
          />
        </Field>
        <Field label="Order status" htmlFor="order-status">
          <Select
            id="order-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            {[...new Set(records.map((order) => order.state))]
              .sort()
              .map((state) => (
                <option key={state}>{state}</option>
              ))}
          </Select>
        </Field>
        <Button
          variant="secondary"
          disabled={!filtered.length}
          onClick={exportRecords}
        >
          Export filtered orders
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(order) => order.id}
        emptyTitle="No orders match this view."
      />
      <p className={styles.footer}>
        {filtered.length} of {records.length} records · App-managed OMS only;
        not the complete broker trade book.
      </p>
      <Dialog
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title="Order details"
        labelledBy="order-detail-title"
      >
        {selected && (
          <dl className={styles.detail}>
            <dt>Order ID</dt>
            <dd>{selected.id}</dd>
            <dt>Account domain</dt>
            <dd>live · {brokerLabel}</dd>
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
        <p className={styles.detailNote}>
          Only recorded facts are shown. A complete exchange event timeline is
          not available here.
        </p>
      </Dialog>
    </>
  );
}
