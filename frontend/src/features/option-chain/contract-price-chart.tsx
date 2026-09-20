"use client";
import { DailyChartCanvas } from "./daily-chart-canvas";
import type { BrokerInstrument } from "@/components/instrument-picker";
import { useScripChart } from "./use-scrip-chart";
import { Button } from "@/components/ui/button";
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
      className="screen-stack"
      aria-label={
        instrument ? "Option contract price chart" : "Stored daily chart"
      }
    >
      <h3>
        {dataset?.instrument?.symbol || symbol || "Stored history"} · Daily
        chart
      </h3>
      {instrument?.market === "options" && (
        <p role="note">
          Underlying daily history only—not this option’s premium.
        </p>
      )}
      <p>
        Historical · 1D ·{" "}
        {dataset?.adjustment === "unknown"
          ? "adjustment status unverified"
          : "unadjusted"}
      </p>
      {loading && <p role="status">Loading stored daily candles…</p>}
      {error && <p role="alert">{error}</p>}
      {dataset && (
        <>
          <p>
            {dataset.candles.length} daily candles · {dataset.candles[0].day} to{" "}
            {dataset.candles.at(-1)!.day} · Not live
          </p>
          <DailyChartCanvas
            symbol={dataset.instrument!.symbol}
            candles={dataset.candles}
          />
        </>
      )}
      <details>
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
