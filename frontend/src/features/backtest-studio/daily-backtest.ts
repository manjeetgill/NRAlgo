/** Pure daily cash-equity research engine. Accepts supplied OHLC only; cannot fetch data or place orders. */
import { parse } from "csv-parse/browser/esm/sync";
import type { TemplateId } from "@/features/strategy-library/strategy-templates";
export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface BacktestSettings {
  template: TemplateId;
  first: number;
  second: number;
  capital: number;
  allocation: number;
  stop: number;
  target: number;
  fee: number;
  slippage: number;
}
export interface DailyTrade {
  signalDate: string;
  entryDate: string;
  exitDate: string;
  quantity: number;
  entry: number;
  exit: number;
  pnl: number;
  entryFee: number;
  exitFee: number;
  reason: string;
}

/** Validate full calendar dates, strict ordering, finite positive OHLC and high/low containment. */
export function validateDailyBars(bars: DailyBar[]): void {
  if (bars.length < 60 || bars.length > 10000) {
    throw new Error("Supply 60–10,000 daily rows.");
  }
  bars.forEach((bar, index) => {
    const date = new Date(`${bar.date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== bar.date ||
      (index > 0 && bar.date <= bars[index - 1].date) ||
      [bar.open, bar.high, bar.low, bar.close].some(
        (value) => !Number.isFinite(value) || value <= 0 || value > 100000000,
      ) ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close)
    ) {
      throw new Error(`Invalid or unordered OHLC at row ${index + 2}.`);
    }
  });
}
/** Parse locally with strict columns/size bounds; file contents are never sent to a broker. */
export function parseDailyCsv(text: string): DailyBar[] {
  if (new TextEncoder().encode(text).byteLength > 2000000) {
    throw new Error("CSV must be at most 2 MB.");
  }
  const rows = parse(text, {
    /** Duplicate headers otherwise silently replace a price column in the CSV parser. */
    columns: (headers: string[]) => {
      if (new Set(headers).size !== headers.length) {
        throw new Error("CSV column names must be unique.");
      }
      return headers;
    },
    bom: true,
    trim: true,
    skip_empty_lines: true,
    max_record_size: 1024,
  }) as Record<string, string>[];
  if (
    !rows.length ||
    !["date", "open", "high", "low", "close"].every((name) =>
      Object.hasOwn(rows[0], name),
    )
  ) {
    throw new Error("Required CSV columns: date,open,high,low,close.");
  }
  const bars = rows.map((row) => ({
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
  validateDailyBars(bars);
  return bars;
}
/** Bound numeric work and capital assumptions before performing any calculations. */
export function validateBacktestSettings(settings: BacktestSettings): void {
  const {
    template,
    first,
    second,
    capital,
    allocation,
    stop,
    target,
    fee,
    slippage,
  } = settings;
  if (
    !["ema", "rsi", "breakout"].includes(template) ||
    !Object.values(settings)
      .filter((value) => typeof value === "number")
      .every(Number.isFinite)
  ) {
    throw new Error("Invalid strategy parameters.");
  }
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(second) ||
    first < 2 ||
    first > 500 ||
    second < 2 ||
    second > 500
  ) {
    throw new Error("Indicator parameters must be integers from 2 to 500.");
  }
  if (template === "ema" && first >= second) {
    throw new Error("Fast EMA must be shorter than slow EMA.");
  }
  if (template === "rsi" && (second <= 30 || second >= 100)) {
    throw new Error("Exit RSI must be above 30 and below 100.");
  }
  if (
    capital < 100 ||
    capital > 10000000 ||
    allocation <= 0 ||
    allocation > 100 ||
    stop <= 0 ||
    stop >= 100 ||
    target <= 0 ||
    target > 1000 ||
    fee < 0 ||
    fee > 10000 ||
    slippage < 0 ||
    slippage > 500
  ) {
    throw new Error(
      "Capital, allocation, risk or cost settings are outside supported limits.",
    );
  }
}
/** SMA-seeded EMA uses no values later than the current bar. */
function ema(values: number[], period: number): (number | null)[] {
  let previous: number | null = null;
  return values.map((value, index) => {
    if (index < period - 1) {
      return null;
    }
    previous =
      previous === null
        ? values.slice(0, period).reduce((sum, item) => sum + item, 0) / period
        : previous + (2 / (period + 1)) * (value - previous);
    return previous;
  });
}
/** Wilder RSI seeds gains/losses over the first complete period; a flat series has RSI 50. */
function rsi(values: number[], period: number): (number | null)[] {
  let gain = 0,
    loss = 0;
  return values.map((value, index) => {
    if (!index) {
      return null;
    }
    const change = value - values[index - 1];
    if (index <= period) {
      gain += Math.max(change, 0) / period;
      loss += Math.max(-change, 0) / period;
    } else {
      gain = (gain * (period - 1) + Math.max(change, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    }
    return index < period
      ? null
      : loss === 0
        ? gain === 0
          ? 50
          : 100
        : 100 - 100 / (1 + gain / loss);
  });
}
/** Calculate next-open entries/exits, adverse costs, stop-first ambiguity and close-marked equity. */
export function runDailyBacktest(bars: DailyBar[], settings: BacktestSettings) {
  validateDailyBars(bars);
  validateBacktestSettings(settings);
  const warmup =
    settings.template === "rsi"
      ? settings.first + 1
      : Math.max(settings.first, settings.second);
  if (bars.length <= warmup + 1) {
    throw new Error("Not enough candles after indicator warm-up.");
  }
  const closes = bars.map((bar) => bar.close),
    fast = ema(closes, settings.first),
    slow = ema(closes, settings.second),
    strength = rsi(closes, settings.first);
  let cash = settings.capital,
    peak = cash,
    drawdown = 0,
    totalFees = 0,
    skippedEntries = 0;
  let position: {
    signalDate: string;
    entryDate: string;
    entry: number;
    quantity: number;
  } | null = null;
  let enterNext = false,
    exitNext = false;
  const trades: DailyTrade[] = [],
    equity: { date: string; value: number }[] = [];
  const slip = settings.slippage / 10000;
  /** Close an existing position with adverse slippage and both fill fees reflected in net P&L. */
  function closePosition(price: number, date: string, reason: string) {
    if (!position) {
      return;
    }
    const exit = price * (1 - slip),
      pnl = (exit - position.entry) * position.quantity - settings.fee * 2;
    cash += exit * position.quantity - settings.fee;
    totalFees += settings.fee;
    trades.push({
      ...position,
      exitDate: date,
      exit,
      pnl,
      entryFee: settings.fee,
      exitFee: settings.fee,
      reason,
    });
    position = null;
  }
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    // Existing exposure encounters the opening gap before a prior-bar rule exit (04-T04).
    // Newly opened positions are handled by the intrabar branch below, never by this gap check.
    if (position) {
      const stop = position.entry * (1 - settings.stop / 100);
      const target = position.entry * (1 + settings.target / 100);
      if (bar.open <= stop) {
        closePosition(bar.open, bar.date, "Gap below stop");
      } else if (bar.open >= target) {
        closePosition(bar.open, bar.date, "Gap above target");
      }
    }
    if (position && exitNext) {
      closePosition(bar.open, bar.date, "Signal exit at next open");
    }
    if (!position && enterNext) {
      const entry = bar.open * (1 + slip),
        budget = Math.max(0, (cash * settings.allocation) / 100 - settings.fee),
        quantity = Math.floor(budget / entry);
      if (quantity > 0) {
        position = {
          signalDate: bars[index - 1].date,
          entryDate: bar.date,
          entry,
          quantity,
        };
        cash -= entry * quantity + settings.fee;
        totalFees += settings.fee;
      } else {
        skippedEntries++;
      }
    }
    enterNext = false;
    exitNext = false;
    if (position) {
      const stop = position.entry * (1 - settings.stop / 100),
        target = position.entry * (1 + settings.target / 100);
      if (bar.low <= stop) {
        // A newly entered position can already breach its stop because of modeled slippage.
        closePosition(
          Math.min(bar.open, stop),
          bar.date,
          bar.high >= target
            ? "Stop (both stop and target touched; stop first)"
            : "Stop",
        );
      } else if (bar.high >= target) {
        closePosition(target, bar.date, "Target");
      }
    }
    if (index === bars.length - 1 && position) {
      closePosition(bar.close, bar.date, "Final bar close");
    }
    const value = cash + (position ? position.quantity * bar.close : 0);
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, (100 * (peak - value)) / peak);
    equity.push({ date: bar.date, value });
    if (index < warmup) {
      continue;
    }
    let entrySignal = false,
      exitSignal = false;
    if (settings.template === "ema") {
      entrySignal =
        fast[index - 1]! <= slow[index - 1]! && fast[index]! > slow[index]!;
      exitSignal =
        fast[index - 1]! >= slow[index - 1]! && fast[index]! < slow[index]!;
    } else if (settings.template === "rsi") {
      entrySignal = strength[index - 1]! <= 30 && strength[index]! > 30;
      exitSignal = strength[index]! >= settings.second;
    } else {
      entrySignal =
        bar.close >
        Math.max(
          ...bars.slice(index - settings.first, index).map((item) => item.high),
        );
      exitSignal =
        bar.close <
        Math.min(
          ...bars.slice(index - settings.second, index).map((item) => item.low),
        );
    }
    enterNext = !position && entrySignal;
    exitNext = Boolean(position && exitSignal);
  }
  const wins = trades.filter((trade) => trade.pnl > 0),
    losses = trades.filter((trade) => trade.pnl < 0),
    grossLoss = -losses.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    settings: { ...settings },
    source: "user-supplied daily OHLC",
    from: bars[0].date,
    to: bars.at(-1)!.date,
    endingEquity: cash,
    returnPercent: (100 * (cash - settings.capital)) / settings.capital,
    drawdownPercent: drawdown,
    winRate: trades.length ? (100 * wins.length) / trades.length : null,
    profitFactor: grossLoss
      ? wins.reduce((sum, trade) => sum + trade.pnl, 0) / grossLoss
      : null,
    totalFees,
    skippedEntries,
    equity,
    trades,
  };
}
