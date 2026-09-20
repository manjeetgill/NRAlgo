"use client";
import { DailyChartCanvas } from "./daily-chart-canvas";
import type { BrokerInstrument } from "@/components/instrument-picker";
import { useScripChart } from "./use-scrip-chart";
import { Button } from "@/components/ui/button";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import styles from "./contract-price-chart.module.css";
/** Stored EOD prices only; never broker calls or synthetic intraday candles. */
export default function ContractPriceChart({
  instrument,
  eodId,
}: {
  instrument?: BrokerInstrument;
  eodId?: string;
}) {
  const symbol = instrument?.symbol;
  const { dataset, error, loading, reload } = useScripChart(
    eodId || symbol ? { id: eodId, symbol } : null,
  );
  return (
    <section
      className={`screen-stack ${styles.card}`}
      aria-label={
        instrument ? "Option contract price chart" : "Stored daily chart"
      }
    >
      <h3>
        {dataset?.instrument?.symbol || symbol || "Stored history"} · Daily
        chart
      </h3>
      {instrument?.market === "options" && (
        <p role="note" className={styles.note}>
          Underlying daily history only—not this option’s premium.
        </p>
      )}
      <p className={styles.meta}>
        Historical · 1D ·{" "}
        {dataset?.adjustment === "unknown"
          ? "adjustment status unverified"
          : "unadjusted"}
      </p>
      <AsyncBoundary
        status={loading ? "loading" : error ? "error" : "success"}
        error={error}
        onRetry={reload}
        isEmpty={!dataset}
        emptyTitle="No stored candles"
        emptyDescription="No daily candles imported for this scrip yet."
      >
        {dataset && (
          <>
            <p className={styles.summary}>
              {dataset.candles.length} daily candles · {dataset.candles[0].day}{" "}
              to {dataset.candles.at(-1)!.day} · Not live
            </p>
            <DailyChartCanvas
              symbol={dataset.instrument!.symbol}
              candles={dataset.candles}
            />
          </>
        )}
      </AsyncBoundary>
      <details className={styles.details}>
        <summary>Chart details</summary>
        <p>
          Drawings and indicators reset on close or reload. Missing sessions are
          not filled. Historical data only, not live prices.
        </p>
        <Button variant="secondary" disabled={loading} onClick={reload}>
          Reload stored candles
        </Button>
        <a href="/legal/charting" target="_blank" rel="noopener noreferrer">
          Chart license and attribution
        </a>
      </details>
    </section>
  );
}
