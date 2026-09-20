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
  const option =
    instrument?.market === "options" ? instrument.option : undefined;
  const selectedId =
    instrument?.market === "options"
      ? option
        ? `NSE:FO:${symbol}:${option.expiryDate}:${option.right}:${option.strikePrice}`
        : "NSE:FO:unavailable"
      : eodId;
  const { dataset, error, loading, reload } = useScripChart(
    selectedId || symbol ? { id: selectedId, symbol } : null,
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
          Exact expiry, strike and CE/PE daily premiums. No underlying-price
          substitution.
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
            {dataset.sources.some((source) => source.startsWith("nse-")) && (
              <p className={styles.meta}>
                Source: NSE official daily reports. End-of-day prices, not live
                quotes.
              </p>
            )}
            {Date.now() - Date.parse(dataset.candles.at(-1)!.day) >
              7 * 86400000 && (
              <p role="note" className={styles.note}>
                Data is out of date. Latest available candle:{" "}
                {dataset.candles.at(-1)!.day}. The NSE daily update is needed.
              </p>
            )}
            {dataset.gaps.length > 0 && (
              <p role="note" className={styles.note}>
                History has {dataset.gaps.length} gap(s) longer than 10 calendar
                days. Missing sessions are not filled; indicators across gaps
                may be misleading.
              </p>
            )}
            {dataset.excludedSessions > 0 && (
              <p role="note" className={styles.note}>
                {dataset.excludedSessions} sessions omitted because traded OHLC
                was unavailable or invalid. Settlement prices are not used as
                candles.
              </p>
            )}
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
