/** Read-only broker history transport. The browser supplies contract identity, never candles or credentials. */
import { requestApiJson } from "./api";
import type { BrokerInstrument } from "@/components/instrument-picker";

export type HistoryInterval = "1minute" | "5minute" | "day";
export interface HistoryRequest {
  market: "cash" | "options";
  stockCode: string;
  instrument: string;
  expiryDate?: string;
  right?: "call" | "put";
  strikePrice?: number;
  from: string;
  to: string;
  interval: HistoryInterval;
}
export interface HistoryCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openInterest: number | null;
}
export interface HistoryDataset {
  source: string;
  instrument: BrokerInstrument;
  request: HistoryRequest;
  candles: HistoryCandle[];
  fetchedAt: string;
  adjustmentPolicy: string;
  coverage: string;
}

/** Serialize the selected master contract without trusting display labels or option aliases. */
export function historyRequestFor(
  instrument: BrokerInstrument,
  from: string,
  to: string,
  interval: HistoryInterval,
): HistoryRequest {
  return {
    market: instrument.market,
    stockCode: instrument.symbol,
    instrument: instrument.instrument,
    from,
    to,
    interval,
    ...(instrument.option
      ? {
          expiryDate: instrument.option.expiryDate,
          right: instrument.option.right,
          strikePrice: instrument.option.strikePrice,
        }
      : {}),
  };
}

/** IST calendar dates avoid browser-timezone drift for requests and daily backtests. */
export function historyDay(offsetDays = 0, now = Date.now()): string {
  return new Date(now + 19800000 + offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
}

/** Check response scope and sorted finite candles before handing data to engines or canvas APIs. */
export function validateHistoryDataset(
  data: HistoryDataset,
  request: HistoryRequest,
): HistoryDataset {
  if (
    !data ||
    typeof data.source !== "string" ||
    !data.source ||
    !data.request ||
    Object.keys(request).some(
      (key) =>
        data.request[key as keyof HistoryRequest] !==
        request[key as keyof HistoryRequest],
    ) ||
    data.instrument?.instrument !== request.instrument ||
    data.instrument.symbol !== request.stockCode ||
    !Number.isFinite(Date.parse(data.fetchedAt)) ||
    !Array.isArray(data.candles) ||
    !data.candles.length ||
    data.candles.length > 20000
  ) {
    throw new Error(
      "Historical response does not match the selected contract and range.",
    );
  }
  let previous = -Infinity;
  for (const candle of data.candles) {
    const time = Date.parse(candle.timestamp);
    const day = Number.isFinite(time) ? historyDay(0, time) : "";
    if (
      !Number.isFinite(time) ||
      time <= previous ||
      day < request.from ||
      day > request.to ||
      [candle.open, candle.high, candle.low, candle.close].some(
        (value) => !Number.isFinite(value) || value <= 0 || value > 100000000,
      ) ||
      candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close)
    ) {
      throw new Error(
        "Historical response contains invalid or unordered candles.",
      );
    }
    previous = time;
  }
  return data;
}

/** One explicit history request; no automatic polling, CSV fallback, token exposure or order side effects. */
export async function fetchMarketHistory(
  request: HistoryRequest,
  csrf: string,
  signal: AbortSignal,
): Promise<HistoryDataset> {
  const data = await requestApiJson(
    "/market/history",
    "POST",
    request,
    csrf,
    95000,
    signal,
  );
  return validateHistoryDataset(data, request);
}
