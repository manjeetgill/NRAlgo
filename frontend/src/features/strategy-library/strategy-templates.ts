/** Versioned, transparent signal rules. Templates contain parameters, never prices or performance claims. */
export type TemplateId = "ema" | "rsi" | "breakout";
export const strategyTemplates = [
  {
    id: "ema" as const,
    name: "EMA crossover",
    category: "Trend following",
    entry: "Fast EMA crosses above slow EMA at candle close.",
    exit: "Fast EMA crosses below slow EMA. Also stop-loss or target.",
    first: "Fast EMA period",
    second: "Slow EMA period",
    defaults: [9, 21],
  },
  {
    id: "rsi" as const,
    name: "RSI recovery",
    category: "Mean reversion",
    entry: "Wilder RSI crosses upward through 30 at candle close.",
    exit: "RSI reaches the configured exit threshold. Also stop-loss or target.",
    first: "RSI period",
    second: "Exit RSI threshold",
    defaults: [14, 70],
  },
  {
    id: "breakout" as const,
    name: "Channel breakout",
    category: "Momentum",
    entry: "Close exceeds the highest high of the preceding entry window.",
    exit: "Close falls below the lowest low of the preceding exit window. Also stop-loss or target.",
    first: "Entry lookback",
    second: "Exit lookback",
    defaults: [20, 10],
  },
] as const;
