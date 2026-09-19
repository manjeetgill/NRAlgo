"use client";
/** Render saved daily candles and local drawing overlays; never fetch broker data or trade. */
import { useEffect, useRef, useState } from "react";
import { init, dispose, type Chart } from "klinecharts";

type Candle = {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};
type IndicatorName = "MA" | "EMA" | "BOLL" | "RSI" | "MACD" | "VOL";
const indicators: IndicatorName[] = ["MA", "EMA", "BOLL", "RSI", "MACD", "VOL"];
const drawings = [
  ["segment", "Trend line", "Click two points on the price chart."],
  [
    "horizontalStraightLine",
    "Horizontal line",
    "Click a price level on the chart.",
  ],
  ["rayLine", "Ray", "Click a starting point and a second point."],
  [
    "fibonacciLine",
    "Fibonacci retracement",
    "Click the swing start and swing end.",
  ],
] as const;

export function DailyChartCanvas({
  symbol,
  candles,
}: {
  symbol: string;
  candles: Candle[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const pending = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [active, setActive] = useState<IndicatorName[]>([]);
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [drawingCount, setDrawingCount] = useState(0);
  const hasVolume = candles.every((bar) => bar.volume !== null);
  const fit = (count: number) => {
    const instance = chart.current;
    if (!instance) {
      return;
    }
    const width =
      instance.getSize("candle_pane", "main")?.width ??
      host.current?.clientWidth ??
      600;
    instance.setOffsetRightDistance(0);
    instance.setBarSpace(
      Math.max(0.01, Math.min(50, width / Math.max(1, count))),
    );
    instance.scrollToRealTime();
  };
  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    let observer: ResizeObserver | undefined;
    setReady(false);
    setError("");
    setMessage("");
    setSelectedDrawing(null);
    setDrawingCount(0);
    pending.current = null;
    try {
      const instance = init(element, {
        locale: "en-US",
        timezone: "Asia/Kolkata",
        layout: { barSpaceLimit: { min: 0.01, max: 50 } },
      });
      if (!instance) {
        throw new Error("Chart initialization failed.");
      }
      chart.current = instance;
      instance.setSymbol({
        ticker: symbol,
        pricePrecision: 2,
        volumePrecision: 0,
      });
      instance.setPeriod({ type: "day", span: 1 });
      instance.setDataLoader({
        getBars: ({ type, callback }) =>
          callback(
            type === "init"
              ? candles.map((bar) => ({
                  timestamp: Date.parse(`${bar.day}T00:00:00+05:30`),
                  open: bar.open,
                  high: bar.high,
                  low: bar.low,
                  close: bar.close,
                  ...(bar.volume === null ? {} : { volume: bar.volume }),
                }))
              : [],
            false,
          ),
      });
      instance.createIndicator({ name: "MA", paneId: "candle_pane" }, true);
      if (hasVolume) {
        instance.createIndicator("VOL");
      }
      setActive(hasVolume ? ["MA", "VOL"] : ["MA"]);
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(element);
      instance.resize();
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to render chart.");
    }
    return () => {
      observer?.disconnect();
      dispose(element);
      chart.current = null;
    };
  }, [candles, symbol, hasVolume]);

  const cancelDrawing = () => {
    if (pending.current) {
      chart.current?.removeOverlay({ id: pending.current });
      pending.current = null;
    }
    setMessage("");
  };
  const draw = (name: string, hint: string) => {
    cancelDrawing();
    setSelectedDrawing(null);
    const id = chart.current?.createOverlay({
      name,
      paneId: "candle_pane",
      onDrawEnd: () => {
        pending.current = null;
        setDrawingCount(chart.current?.getOverlays().length ?? 0);
        setMessage("");
        return false;
      },
      onSelected: ({ overlay }) => {
        setSelectedDrawing(overlay.id);
        return false;
      },
      onDeselected: () => {
        setSelectedDrawing(null);
        return false;
      },
      onRemoved: ({ overlay }) => {
        if (pending.current === overlay.id) {
          pending.current = null;
        }
        setDrawingCount(
          chart.current?.getOverlays().filter((item) => item.id !== overlay.id)
            .length ?? 0,
        );
        setSelectedDrawing((id) => (id === overlay.id ? null : id));
        return false;
      },
    });
    if (typeof id === "string") {
      pending.current = id;
      setMessage(hint);
    } else {
      setError("Could not start drawing.");
    }
  };
  const toggleIndicator = (selectedIndicator: IndicatorName) => {
    if (active.includes(selectedIndicator)) {
      chart.current?.removeIndicator({ name: selectedIndicator });
      setActive((value) => value.filter((name) => name !== selectedIndicator));
      return;
    }
    const price = ["MA", "EMA", "BOLL"].includes(selectedIndicator);
    const id = chart.current?.createIndicator(
      { name: selectedIndicator, ...(price ? { paneId: "candle_pane" } : {}) },
      true,
    );
    if (id) {
      setActive((value) => [...value, selectedIndicator]);
    } else {
      setError("Could not add indicator.");
    }
  };
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div
        role="group"
        aria-label="Chart tools"
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <select
          aria-label="Indicators"
          style={{ width: "auto", flex: "1 1 140px", minWidth: 0 }}
          title="Select an indicator to add or remove it"
          value=""
          disabled={!ready}
          onChange={(event) =>
            toggleIndicator(event.target.value as IndicatorName)
          }
        >
          <option value="" disabled>
            Indicators{active.length ? ` (${active.length})` : ""}
          </option>
          {indicators.map((name) => (
            <option
              key={name}
              value={name}
              disabled={name === "VOL" && !hasVolume}
            >
              {active.includes(name) ? "✓ " : ""}
              {name}
              {name === "VOL" && !hasVolume ? " · volume unavailable" : ""}
            </option>
          ))}
        </select>
        <select
          aria-label="Drawing tools"
          style={{ width: "auto", flex: "1 1 140px", minWidth: 0 }}
          value=""
          disabled={!ready}
          onChange={(event) => {
            const action = event.target.value;
            if (action === "cancel") {
              cancelDrawing();
            } else if (action === "delete" && selectedDrawing) {
              chart.current?.removeOverlay({ id: selectedDrawing });
              setSelectedDrawing(null);
              setDrawingCount(chart.current?.getOverlays().length ?? 0);
              setMessage("");
            } else if (action === "clear") {
              chart.current?.removeOverlay();
              pending.current = null;
              setSelectedDrawing(null);
              setDrawingCount(0);
              setMessage("");
            } else {
              const tool = drawings.find(([name]) => name === action);
              if (tool) {
                draw(tool[0], tool[2]);
              }
            }
          }}
        >
          <option value="" disabled>
            Drawings
          </option>
          {drawings.map(([name, label]) => (
            <option key={name} value={name}>
              {label}
            </option>
          ))}
          <option value="cancel">Cancel drawing</option>
          <option value="delete" disabled={!selectedDrawing}>
            Delete selected
          </option>
          <option value="clear">
            Clear drawings{drawingCount ? ` (${drawingCount})` : ""}
          </option>
        </select>
        <select
          aria-label="Chart range"
          style={{ width: "auto", flex: "1 1 120px", minWidth: 0 }}
          value=""
          disabled={!ready}
          onChange={(event) =>
            fit(
              event.target.value === "all"
                ? candles.length
                : Math.min(250, candles.length),
            )
          }
        >
          <option value="" disabled>
            View
          </option>
          <option value="all">Full history</option>
          <option value="recent">Latest 250 sessions</option>
        </select>
      </div>
      {message && <p role="status">{message}</p>}
      <div
        ref={host}
        role="img"
        aria-label="Daily candlestick chart"
        data-candle-count={candles.length}
        style={{ height: 560, width: "100%", minWidth: 0 }}
      />
    </>
  );
}
