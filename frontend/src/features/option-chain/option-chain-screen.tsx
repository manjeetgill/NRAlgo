"use client";
/** Reference-style chain with separate research drafts and explicit broker order review. */
import {
  LiveOptionChain,
  type ChainContract,
} from "@/components/live-option-chain";
import { Button } from "@/components/ui/button";
import { useMarketFeed } from "./use-market-feed";
import { useEffect, useRef, useState } from "react";
import { UnderlyingSearch } from "@/components/underlying-search";
import { IndependentChart } from "./independent-chart";
import { LiveOrderTicket } from "@/features/live-trading/live-order-ticket";
import { useBrokerRegistry } from "@/features/brokers/broker-hooks";
import styles from "./option-chain.module.css";
/** Initial selection loads metadata/quotes once; subsequent prices use the shared stream cache. */
export function OptionChainScreen({
  csrf,
  legCount,
  onAddLeg,
  onOpenBuilder,
}: {
  csrf: string;
  legCount: number;
  onAddLeg: (contract: ChainContract, side: "buy" | "sell") => string;
  onOpenBuilder: (selection: {
    underlying: string;
    expiry?: string;
    day?: string;
    spot?: number;
  }) => void;
}) {
  const [underlying, setUnderlying] = useState("NIFTY");
  const [reference, setReference] = useState<{
    spot: number;
    expiry?: string;
    day?: string;
  } | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [essentialColumns, setEssentialColumns] = useState(true);
  /** Choose a compact initial view on phones; the user's column choice then stays in control. */
  useEffect(
    () => setEssentialColumns(window.matchMedia("(max-width: 760px)").matches),
    [],
  );
  const [dataMode, setDataMode] = useState<"live" | "historical" | null>(null);
  const feed = useMarketFeed(csrf, Boolean(underlying) && dataMode === "live");
  const brokers = useBrokerRegistry(csrf, null);
  const activeBroker = brokers.brokers.find(
    (broker) => broker.id === brokers.activeBrokerId,
  );
  const [order, setOrder] = useState<{
    contract: ChainContract;
    side: "buy" | "sell";
  } | null>(null);
  const orderDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (order) {
      orderDialog.current?.showModal();
    }
  }, [order]);
  return (
    <section
      className={`screen-stack ${styles.workspace}`}
      aria-label="Option chain workspace"
    >
      <div className={styles.toolbar}>
        <div>
          <h2>Option chain</h2>
        </div>
        <label>
          Index / Stock
          <select
            aria-label="Option chain index or stock"
            value={
              [
                "NIFTY",
                "BANKNIFTY",
                "FINNIFTY",
                "MIDCPNIFTY",
                "NIFTYNXT50",
              ].includes(underlying)
                ? underlying
                : "stock"
            }
            onChange={(event) => {
              setReference(null);
              setUnderlying(
                event.target.value === "stock" ? "" : event.target.value,
              );
            }}
          >
            {["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"].map(
              (symbol) => (
                <option key={symbol}>{symbol}</option>
              ),
            )}
            <option value="stock">Search stock…</option>
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={!underlying}
          onClick={() => onOpenBuilder({ underlying, ...reference })}
        >
          Build payoff ({legCount})
        </Button>
        <label>
          Columns
          <select
            value={essentialColumns ? "essential" : "all"}
            onChange={(event) =>
              setEssentialColumns(event.target.value === "essential")
            }
          >
            <option value="essential">Premiums & strike</option>
            <option value="all">All columns & Greeks</option>
          </select>
        </label>
        <div className={styles.broker}>
          <span>
            For live trading:{" "}
            {activeBroker
              ? `${activeBroker.provider.toUpperCase()} · ${activeBroker.status}`
              : "No active broker"}
          </span>{" "}
          <a href="#/brokers">Manage brokers →</a>
        </div>
      </div>
      {brokers.error && <p role="alert">{brokers.error}</p>}
      <p className={styles.notes}>
        Select a premium to inspect the contract or add a payoff leg.{" "}
        {dataMode === "historical"
          ? "Historical snapshot: live order review is unavailable."
          : activeBroker?.status !== "connected"
            ? "Connect your execution broker to review live orders."
            : "B / S opens order review; it never submits immediately."}
      </p>
      {!["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"].includes(
        underlying,
      ) && (
        <UnderlyingSearch
          csrf={csrf}
          selected={underlying}
          onSelect={(symbol) => {
            setReference(null);
            setUnderlying(symbol);
          }}
        />
      )}
      {underlying && feed.error && (
        <p role="alert" className="error">
          {feed.error}
        </p>
      )}
      {underlying && (
        <LiveOptionChain
          key={underlying}
          selectedUnderlying={underlying}
          experience="chain"
          onDataMode={setDataMode}
          onReferenceData={setReference}
          csrf={csrf}
          ticks={dataMode === "live" ? feed.ticks : []}
          onAddLeg={onAddLeg}
          compact
          analytics
          essentialColumns={essentialColumns}
          onTrade={
            activeBroker?.status === "connected" && dataMode === "live"
              ? (contract, side) => setOrder({ contract, side })
              : undefined
          }
        />
      )}
      <details className={styles.notes}>
        <summary>Data & order information</summary>
        <p>
          B / S opens live order review; selecting a row never submits an order.
          IV and Greeks are calculated from available premiums and are not
          guaranteed executable values.
        </p>
      </details>
      {!underlying && (
        <p className={styles.empty}>
          Select an index or stock above to load expiries and the option chain.
        </p>
      )}
      <details onToggle={(event) => setChartOpen(event.currentTarget.open)}>
        <summary>Historical price chart</summary>
        {chartOpen && <IndependentChart />}
      </details>
      <dialog
        ref={orderDialog}
        className={`workspace-dialog ${styles.ticket}`}
        onClose={() => setOrder(null)}
        aria-label="Review option order"
      >
        <Button
          variant="secondary"
          onClick={() => orderDialog.current?.close()}
        >
          Close order review
        </Button>
        {order && (
          <LiveOrderTicket
            key={`${brokers.activeBrokerId}:${order.contract.symbol}:${order.side}`}
            csrf={csrf}
            initialOrder={order}
          />
        )}
      </dialog>
    </section>
  );
}
