"use client";
import { useState } from "react";
import { DailyChartCanvas, type ChartInterval } from "./daily-chart-canvas";
import { aggregateCandles, type Interval } from "./aggregate-candles";
import {
  bucketTicksToBars,
  regularMarketSessionOpen,
  type IntradaySpanMinutes,
} from "./intraday-candles";
import { useLiveIntraday } from "./use-live-intraday";
import type { BrokerInstrument } from "@/components/instrument-picker";
import { useScripChart } from "./use-scrip-chart";
import { Button } from "@/components/ui/button";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Tabs } from "@/components/ui/tabs";
import styles from "./contract-price-chart.module.css";

const storedIntervalItems: { key: Interval; label: string }[] = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
];
const liveSpanItems: { key: IntradaySpanMinutes; label: string }[] = [
  { key: 1, label: "1m" },
  { key: 5, label: "5m" },
  { key: 15, label: "15m" },
  { key: 30, label: "30m" },
  { key: 60, label: "1h" },
];
const liveIntervalFor: Record<IntradaySpanMinutes, ChartInterval> = {
  1: "1m",
  5: "5m",
  15: "15m",
  30: "30m",
  60: "1h",
};

/** Stored EOD prices by default; a connected broker's live ticks during market hours
 * roll up into intraday candles client-side instead. Never synthetic candles. */
export default function ContractPriceChart({
  instrument,
  eodId,
  csrf,
}: {
  instrument?: BrokerInstrument;
  eodId?: string;
  /** Enables the "Live" intraday view; omit to keep this a stored-history-only chart. */
  csrf?: string;
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
  const [storedInterval, setStoredInterval] = useState<Interval>("day");
  const [liveSpan, setLiveSpan] = useState<IntradaySpanMinutes>(1);
  const [live, setLive] = useState(false);
  // Live mode only ever applies to a plain cash scrip, never an option contract.
  const canGoLive =
    Boolean(csrf) && !instrument && regularMarketSessionOpen(Date.now());
  const liveSymbol = dataset?.instrument?.symbol || symbol || "";
  const liveData = useLiveIntraday(liveSymbol, csrf || "", live && canGoLive);
  const chartInterval: ChartInterval =
    live && canGoLive ? liveIntervalFor[liveSpan] : storedInterval;
  const displayedCandles =
    live && canGoLive
      ? bucketTicksToBars(liveData.ticks, liveSpan)
      : dataset
        ? aggregateCandles(dataset.candles, storedInterval)
        : [];
  return (
    <section
      className={`screen-stack ${styles.card}`}
      aria-label={
        instrument ? "Option contract price chart" : "Stored daily chart"
      }
    >
      <h3>
        {dataset?.instrument?.symbol || symbol || "Stored history"} ·{" "}
        {live && canGoLive
          ? `Live ${liveSpanItems.find((item) => item.key === liveSpan)?.label}`
          : storedIntervalItems.find((item) => item.key === storedInterval)
              ?.label}{" "}
        chart
      </h3>
      {instrument?.market === "options" && (
        <p role="note" className={styles.note}>
          Exact expiry, strike and CE/PE daily premiums. No underlying-price
          substitution.
        </p>
      )}
      <div role="group" aria-label="Chart view" className={styles.viewRow}>
        <Tabs
          items={[
            ...storedIntervalItems,
            ...(canGoLive ? [{ key: "live" as const, label: "Live" }] : []),
          ]}
          active={live && canGoLive ? "live" : storedInterval}
          onChange={(key) => {
            if (key === "live") {
              setLive(true);
              return;
            }
            setLive(false);
            setStoredInterval(key as Interval);
          }}
        />
        {live && canGoLive && (
          <Tabs
            items={liveSpanItems.map((item) => ({
              key: String(item.key),
              label: item.label,
            }))}
            active={String(liveSpan)}
            onChange={(key) => setLiveSpan(Number(key) as IntradaySpanMinutes)}
          />
        )}
      </div>
      <p className={styles.meta}>
        {live && canGoLive
          ? `Live · broker ticks · ${liveSpanItems.find((item) => item.key === liveSpan)?.label} candles · not delayed`
          : `Historical · ${
              storedInterval === "day"
                ? "1D"
                : storedInterval === "week"
                  ? "1W"
                  : "1M"
            } · ${
              dataset?.adjustment === "unknown"
                ? "adjustment status unverified"
                : "unadjusted"
            }`}
      </p>
      {live && canGoLive ? (
        <AsyncBoundary
          status={
            liveData.error ? "error" : liveData.ready ? "success" : "loading"
          }
          error={liveData.error}
          isEmpty={liveData.ready && displayedCandles.length === 0}
          emptyTitle="Waiting for ticks"
          emptyDescription="No trades observed yet for this symbol in the current session."
        >
          <p className={styles.summary}>
            {displayedCandles.length} live candle
            {displayedCandles.length === 1 ? "" : "s"} this session · Broker
            feed, not stored history
          </p>
          <DailyChartCanvas
            symbol={liveSymbol}
            candles={displayedCandles}
            interval={chartInterval}
          />
        </AsyncBoundary>
      ) : (
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
                {displayedCandles.length}{" "}
                {storedInterval === "day"
                  ? "daily"
                  : storedInterval === "week"
                    ? "weekly"
                    : "monthly"}{" "}
                candles · {dataset.candles[0].day} to{" "}
                {dataset.candles.at(-1)!.day} · Not live
              </p>
              {dataset.sources.some((source) => source.startsWith("nse-")) && (
                <p className={styles.meta}>
                  Source: NSE official daily reports. End-of-day prices, not
                  live quotes.
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
                  History has {dataset.gaps.length} gap(s) longer than 10
                  calendar days. Missing sessions are not filled; indicators
                  across gaps may be misleading.
                </p>
              )}
              {dataset.excludedSessions > 0 && (
                <p role="note" className={styles.note}>
                  {dataset.excludedSessions} sessions omitted because traded
                  OHLC was unavailable or invalid. Settlement prices are not
                  used as candles.
                </p>
              )}
              <DailyChartCanvas
                symbol={dataset.instrument!.symbol}
                candles={displayedCandles}
                interval={chartInterval}
              />
            </>
          )}
        </AsyncBoundary>
      )}
      <details className={styles.details}>
        <summary>Chart details</summary>
        <p>
          Drawings and indicators reset on close or reload. Missing sessions are
          not filled. Historical data only outside Live mode.
        </p>
        {!(live && canGoLive) && (
          <Button variant="secondary" disabled={loading} onClick={reload}>
            Reload stored candles
          </Button>
        )}
        <a href="/legal/charting" target="_blank" rel="noopener noreferrer">
          Chart license and attribution
        </a>
      </details>
    </section>
  );
}
