/** Broker dataset provenance and local reproducibility manifest; not a durable server job. */
import type { HistoryDataset } from "@/lib/market-history";
import { historyDay } from "@/lib/market-history";
import {
  runDailyBacktest,
  type BacktestSettings,
  type DailyBar,
  validateDailyBars,
} from "./daily-backtest";

export const DAILY_ENGINE_VERSION = "daily-cash-1.1.0";

/** Never reinterpret minute candles as daily data or merge duplicate sessions silently. */
export function dailyBarsFromHistory(dataset: HistoryDataset): DailyBar[] {
  if (dataset.request.interval !== "day" || dataset.request.market !== "cash") {
    throw new Error("This backtest requires broker daily cash-equity history.");
  }
  const bars = dataset.candles.map(({ timestamp, open, high, low, close }) => ({
    date: historyDay(0, Date.parse(timestamp)),
    open,
    high,
    low,
    close,
  }));
  validateDailyBars(bars);
  return bars;
}

/** Hash UTF-8 canonical inputs; no market data or credentials leave the browser. */
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Freeze inputs before awaiting hashes so later form edits cannot rewrite a calculated report. */
export async function createBacktestReport(
  bars: DailyBar[],
  settings: BacktestSettings,
  provenance: Pick<
    HistoryDataset,
    "source" | "request" | "fetchedAt" | "adjustmentPolicy"
  >,
) {
  const dataset = bars.map(({ date, open, high, low, close }) => ({
    date,
    open,
    high,
    low,
    close,
  }));
  const origin = { ...provenance, request: { ...provenance.request } };
  const configuration: BacktestSettings = {
    template: settings.template,
    first: settings.first,
    second: settings.second,
    capital: settings.capital,
    allocation: settings.allocation,
    stop: settings.stop,
    target: settings.target,
    fee: settings.fee,
    slippage: settings.slippage,
  };
  const result = runDailyBacktest(dataset, configuration);
  const [datasetHash, configurationHash] = await Promise.all([
    sha256(JSON.stringify(dataset)),
    sha256(JSON.stringify(configuration)),
  ]);
  return {
    ...result,
    manifest: {
      schemaVersion: 2,
      engineVersion: DAILY_ENGINE_VERSION,
      templateId: configuration.template,
      templateVersion: "1.0.0",
      datasetHash,
      configurationHash,
      provider: origin.source,
      request: origin.request,
      fetchedAt: origin.fetchedAt,
      rowCount: dataset.length,
      timeframe: "1d",
      source: "Broker historical API",
      provenance:
        "Authenticated server-side provider read; not independently exchange-verified",
      adjustmentPolicy: origin.adjustmentPolicy,
      storage: "Local browser memory; not persisted",
      createdAt: new Date().toISOString(),
    },
  };
}
