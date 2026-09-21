"use client";
/** Render saved daily candles and local drawing overlays; never fetch broker data or trade. */
import { useEffect, useRef, useState } from "react";
import {
  init,
  dispose,
  type Chart,
  type DeepPartial,
  type Styles,
} from "klinecharts";
import { Select } from "@/components/ui/field";
import { useTheme } from "@/components/ui/theme-provider";
import styles from "./daily-chart-canvas.module.css";

export type ChartInterval =
  "day" | "week" | "month" | "1m" | "5m" | "15m" | "30m" | "1h";

const intervalLabels: Record<ChartInterval, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  "1m": "1-minute",
  "5m": "5-minute",
  "15m": "15-minute",
  "30m": "30-minute",
  "1h": "1-hour",
};

/** Translate the friendly interval name to klinecharts' period shape. */
function periodFor(interval: ChartInterval) {
  switch (interval) {
    case "1m":
      return { type: "minute" as const, span: 1 };
    case "5m":
      return { type: "minute" as const, span: 5 };
    case "15m":
      return { type: "minute" as const, span: 15 };
    case "30m":
      return { type: "minute" as const, span: 30 };
    case "1h":
      return { type: "hour" as const, span: 1 };
    default:
      return { type: interval, span: 1 };
  }
}

type Candle = {
  day: string;
  /** Set for intraday bars, whose `day` is a full timestamp rather than a plain date. */
  timestamp?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};
type IndicatorName = "MA" | "EMA" | "BOLL" | "RSI" | "MACD" | "VOL";
const indicators: IndicatorName[] = ["MA", "EMA", "BOLL", "RSI", "MACD", "VOL"];
/** Read a design-token value from the live theme so the canvas never hardcodes one palette. */
function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** klinecharts draws to its own canvas; feed it the active theme's tokens rather than fixed colors. */
function buildChartStyles(): DeepPartial<Styles> {
  const textPrimary = readToken("--text-primary", "#eef2fb");
  const textSecondary = readToken("--text-secondary", "#aab4c9");
  const textMuted = readToken("--text-muted", "#707b94");
  const borderSubtle = readToken("--border-subtle", "#1a212e");
  const borderDefault = readToken("--border-default", "#262f42");
  const accent = readToken("--accent", "#5b7cff");
  const success = readToken("--success", "#22c58f");
  const danger = readToken("--danger", "#f2495c");
  const bgOverlay = readToken("--bg-overlay", "#1b2331");
  return {
    grid: {
      horizontal: { color: borderSubtle },
      vertical: { color: borderSubtle },
    },
    candle: {
      bar: {
        upColor: success,
        downColor: danger,
        noChangeColor: textMuted,
        upBorderColor: success,
        downBorderColor: danger,
        noChangeBorderColor: textMuted,
        upWickColor: success,
        downWickColor: danger,
        noChangeWickColor: textMuted,
      },
      priceMark: {
        high: { color: textSecondary },
        low: { color: textSecondary },
        last: {
          upColor: success,
          downColor: danger,
          noChangeColor: textMuted,
        },
      },
      tooltip: {
        legend: { color: textSecondary },
      },
    },
    indicator: {
      lastValueMark: { text: { color: textPrimary } },
    },
    xAxis: {
      axisLine: { color: borderDefault },
      tickLine: { color: borderDefault },
      tickText: { color: textMuted },
    },
    yAxis: {
      axisLine: { color: borderDefault },
      tickLine: { color: borderDefault },
      tickText: { color: textMuted },
    },
    separator: { color: borderDefault },
    crosshair: {
      horizontal: {
        line: { color: textMuted },
        text: { color: bgOverlay, backgroundColor: accent },
      },
      vertical: {
        line: { color: textMuted },
        text: { color: bgOverlay, backgroundColor: accent },
      },
    },
  };
}

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
  interval = "day",
}: {
  symbol: string;
  candles: Candle[];
  interval?: ChartInterval;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const pending = useRef<string | null>(null);
  const { theme } = useTheme();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [active, setActive] = useState<IndicatorName[]>([]);
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [drawingCount, setDrawingCount] = useState(0);
  const [range, setRange] = useState("");
  const rangeRef = useRef(range);
  rangeRef.current = range;
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
  // A fresh chart instance only for a genuine instrument change; indicators/drawings/zoom
  // are user state that must survive switching timeframe on the same symbol.
  const seeded = useRef(false);
  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    let observer: ResizeObserver | undefined;
    setReady(false);
    setRange("");
    setError("");
    setMessage("");
    setSelectedDrawing(null);
    setDrawingCount(0);
    pending.current = null;
    seeded.current = false;
    try {
      const instance = init(element, {
        locale: "en-US",
        timezone: "Asia/Kolkata",
        layout: { barSpaceLimit: { min: 0.01, max: 50 } },
        styles: buildChartStyles(),
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
  }, [symbol]);

  // Refresh period/bars on the existing instance instead of tearing it down, so switching
  // Daily/Weekly/Monthly/intraday spans never silently discards indicators or drawings.
  useEffect(() => {
    const instance = chart.current;
    if (!instance || !ready) {
      return;
    }
    instance.setPeriod(periodFor(interval));
    instance.setDataLoader({
      getBars: ({ type, callback }) =>
        callback(
          type === "init"
            ? candles.map((bar) => ({
                timestamp:
                  bar.timestamp ?? Date.parse(`${bar.day}T00:00:00+05:30`),
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
    if (!seeded.current) {
      instance.createIndicator({ name: "MA", paneId: "candle_pane" }, true);
      if (hasVolume) {
        instance.createIndicator("VOL");
      }
      setActive(hasVolume ? ["MA", "VOL"] : ["MA"]);
      seeded.current = true;
    } else if (rangeRef.current) {
      fit(
        rangeRef.current === "all"
          ? candles.length
          : Math.min(250, candles.length),
      );
    }
  }, [candles, hasVolume, interval, ready]);

  /** Re-read tokens and restyle in place when the viewer toggles light/dark, without a full re-init. */
  useEffect(() => {
    chart.current?.setStyles(buildChartStyles());
  }, [theme]);

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
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div role="group" aria-label="Chart tools" className={styles.toolbar}>
        <Select
          aria-label="Indicators"
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
              {name === "VOL" && !hasVolume
                ? " · incomplete volume history"
                : ""}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Drawing tools"
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
        </Select>
        <Select
          aria-label="Chart range"
          value={range}
          disabled={!ready}
          onChange={(event) => {
            setRange(event.target.value);
            fit(
              event.target.value === "all"
                ? candles.length
                : Math.min(250, candles.length),
            );
          }}
        >
          <option value="" disabled>
            View
          </option>
          <option value="all">Full history</option>
          <option value="recent">Latest 250 sessions</option>
        </Select>
      </div>
      {message && (
        <p className={styles.status} role="status">
          {message}
        </p>
      )}
      <div
        ref={host}
        role="img"
        aria-label={`${intervalLabels[interval]} candlestick chart`}
        data-candle-count={candles.length}
        className={styles.host}
      />
    </>
  );
}
