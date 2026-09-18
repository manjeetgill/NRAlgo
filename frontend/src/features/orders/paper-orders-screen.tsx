"use client";
/** Actual virtual-ledger orders, never synthetic research-job fills. */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { OrderRecordsTable, type OrderRecord } from "./order-records-table";
/** Owner-scoped paper reads are separate from the live OMS and have no automatic polling. */
export function PaperOrdersScreen({ csrf }: { csrf: string }) {
  const [records, setRecords] = useState<OrderRecord[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  /** Fetch only the selected broker's durable paper ledger and normalize paise explicitly. */
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await requestApiJson(
        "/paper/kotak",
        "GET",
        undefined,
        csrf,
      );
      if (!Array.isArray(result.orders)) {
        throw new Error("Paper order records unavailable.");
      }
      if (version === generation.current) {
        setRecords(
          result.orders.map(
            (order: {
              key: string;
              instrument: string;
              side: string;
              quantity: number;
              limitPaise: number;
              state: string;
              fillPaise?: number;
            }) => ({
              id: order.key,
              instrument: order.instrument,
              side: order.side,
              quantity: order.quantity,
              limit: order.limitPaise / 100,
              filled: order.state === "filled" ? order.quantity : 0,
              fillPrice:
                order.fillPaise === undefined ? null : order.fillPaise / 100,
              state: order.state,
            }),
          ),
        );
      }
    } catch (cause) {
      if (version === generation.current) {
        setError(
          cause instanceof Error ? cause.message : "Paper orders unavailable.",
        );
      }
    } finally {
      if (version === generation.current) {
        setLoading(false);
      }
    }
  }, [csrf]);
  /** Fence late reads when navigating or replacing an authenticated session. */
  useEffect(() => {
    void load();
    const gate = generation;
    return () => {
      gate.current++;
    };
  }, [load]);
  /** Explicit remainder cancellation; success is followed by an authoritative ledger read. */
  async function cancel(id: string) {
    await requestApiJson(
      `/paper/kotak/orders/${encodeURIComponent(id)}/cancel`,
      "POST",
      {},
      csrf,
    );
    await load();
  }
  return (
    <section className="panel screen-card" aria-label="Paper orders">
      <div className="screen-toolbar">
        <h2>Orders and fills</h2>
        <Button
          variant="secondary"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh orders
        </Button>
      </div>
      {loading && <p role="status">Loading paper orders…</p>}
      {error && <p role="alert">{error}</p>}
      {records && (
        <OrderRecordsTable mode="paper" records={records} onCancel={cancel} />
      )}
    </section>
  );
}
