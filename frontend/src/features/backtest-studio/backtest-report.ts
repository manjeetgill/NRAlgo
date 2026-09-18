/** Local reproducibility manifest, not a claim of provider-verified data or a durable server job. */
import {
  runDailyBacktest,
  type BacktestSettings,
  type DailyBar,
} from "./daily-backtest";

export const DAILY_ENGINE_VERSION = "daily-cash-1.1.0";

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
  filename: string,
) {
  const dataset = bars.map(({ date, open, high, low, close }) => ({
    date,
    open,
    high,
    low,
    close,
  }));
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
      schemaVersion: 1,
      engineVersion: DAILY_ENGINE_VERSION,
      templateId: configuration.template,
      templateVersion: "1.0.0",
      datasetHash,
      configurationHash,
      filename,
      rowCount: dataset.length,
      timeframe: "1d",
      source: "User-supplied CSV",
      provenance: "Not independently verified",
      adjustmentPolicy: "User supplied; not independently verified",
      storage: "Local browser memory; not persisted",
      createdAt: new Date().toISOString(),
    },
  };
}
