"use client";
/** TradingView Lightweight Charts renders broker candles; it is not a TradingView market-data feed. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type Time,
} from "lightweight-charts";
import type { BrokerInstrument } from "@/components/instrument-picker";
import type { LiveTick } from "@/components/live-option-chain";
import { Button } from "@/components/ui/button";
import { historyDay, historyRequestFor } from "@/lib/market-history";
import { useContractHistory } from "./use-contract-history";

/** Actual UTC chart coordinates with IST labels; browser timezone never changes the plotted instant. */
function formatChartTime(time: number): string {
  return new Date(time * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Mount only while the user opens a contract chart. Dispose canvas/observers and abort reads on close. */
export default function ContractPriceChart({
  instrument,
  csrf,
  tick,
}: {
  instrument: BrokerInstrument;
  csrf: string;
  tick?: LiveTick;
}) {
  const [interval, setInterval] = useState<"1minute" | "5minute">("5minute");
  const [from, setFrom] = useState(() => historyDay(-7));
  const [to, setTo] = useState(() => historyDay());
  const history = useContractHistory(
    historyRequestFor(instrument, from, to, interval),
    csrf,
  );
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLine = useRef<IPriceLine | null>(null);
  const candles = useMemo(
    () =>
      history.dataset?.candles.map((bar) => ({
        time: Math.floor(Date.parse(bar.timestamp) / 1000) as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })) ?? [],
    [history.dataset],
  );

  /** Create one chart instance; autoSize owns responsive observation and remove releases all chart resources. */
  useEffect(() => {
    if (!container.current) {
      return;
    }
    const instance = createChart(container.current, {
      autoSize: true,
      height: 340,
      layout: { attributionLogo: true, textColor: "#475569" },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) =>
          typeof time === "number" ? formatChartTime(time) : String(time),
      },
      localization: {
        locale: "en-IN",
        timeFormatter: (time: Time) =>
          typeof time === "number" ? formatChartTime(time) : String(time),
      },
    });
    chart.current = instance;
    series.current = instance.addSeries(CandlestickSeries, {
      upColor: "#059669",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#059669",
      wickDownColor: "#dc2626",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    return () => {
      instance.remove();
      chart.current = null;
      series.current = null;
      priceLine.current = null;
    };
  }, []);

  /** Replace history only for a new accepted dataset; live price updates preserve the user's zoom. */
  useEffect(() => {
    series.current?.setData(candles);
    chart.current?.timeScale().fitContent();
  }, [candles]);

  /** A received LTP is not a full OHLC candle. Show it separately without manufacturing missing candles/volume. */
  useEffect(() => {
    const target = series.current;
    if (!target) {
      return;
    }
    if (priceLine.current) {
      target.removePriceLine(priceLine.current);
      priceLine.current = null;
    }
    const age = tick?.receivedAt ? Date.now() - tick.receivedAt : Infinity;
    if (
      tick?.instrument === instrument.instrument &&
      tick.exchange === "nse_fo" &&
      tick.receivedRecently &&
      age >= 0 &&
      age <= 15000 &&
      typeof tick.ltp === "number" &&
      Number.isFinite(tick.ltp) &&
      tick.ltp > 0
    ) {
      priceLine.current = target.createPriceLine({
        price: tick.ltp,
        color: "#2563eb",
        lineWidth: 1,
        axisLabelVisible: true,
        title: "Feed LTP",
      });
    }
  }, [tick, instrument.instrument]);

  return (
    <section aria-label="Option contract price chart" className="screen-stack">
      <h3>
        {instrument.symbol} {instrument.option?.strikePrice}{" "}
        {instrument.option?.right} · price chart
      </h3>
      <div className="research-fields">
        <label>
          Chart interval
          <select
            value={interval}
            onChange={(event) =>
              setInterval(event.target.value as "1minute" | "5minute")
            }
          >
            <option value="1minute">1 minute</option>
            <option value="5minute">5 minutes</option>
          </select>
        </label>
        <label>
          Chart from (IST)
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          Chart to (IST)
          <input
            type="date"
            value={to}
            min={from}
            max={historyDay()}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
      </div>
      <Button
        variant="secondary"
        disabled={history.loading}
        onClick={history.reload}
      >
        Reload broker candles
      </Button>
      {history.loading && <p role="status">Loading broker candles…</p>}
      {history.error && (
        <p role="alert" className="error">
          {history.error}
        </p>
      )}
      <div
        ref={container}
        style={{ height: 340, width: "100%", minWidth: 0 }}
        role="img"
        aria-label={`Historical candlestick chart for ${instrument.symbol} ${instrument.option?.strikePrice} ${instrument.option?.right}; timestamps in IST`}
      />
      {history.dataset && (
        <p>
          {history.dataset.source} · {candles.length} candles · fetched{" "}
          {new Date(history.dataset.fetchedAt).toLocaleString("en-IN")} ·
          timestamps IST
        </p>
      )}
      <p>
        Scroll to zoom, drag to pan. Candles load from your broker; the blue LTP
        line uses the same live feed as the option chain. No automatic history
        refresh or reconstructed candles.
      </p>
      <p>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™
        </a>{" "}
        ·{" "}
        <a href="/legal/charting" target="_blank" rel="noreferrer">
          Attribution and license
        </a>
      </p>
    </section>
  );
}
