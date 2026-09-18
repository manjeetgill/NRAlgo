/** Presentation policy shared by the shell and Overview. It never grants execution permission. */
export type TradingMode = "paper" | "live";

/** Only an explicit server boolean enables the simulated workspace; missing settings mean live-only. */
export function getTradingMode(paperTradingEnabled: unknown): TradingMode {
  return paperTradingEnabled === true ? "paper" : "live";
}

/** Only the wallet-specific screen is removed in live mode; research and shared tools remain available. */
export function isTradingPageVisible(page: string, mode: TradingMode): boolean {
  return mode === "paper" ? page !== "Live trading" : page !== "Broker paper";
}

/** Hide explicit paper-account messages, not research/backtest activity. The durable audit is untouched. */
export function isTradingEventVisible(
  message: string,
  mode: TradingMode,
): boolean {
  return mode === "paper" || !/\b(paper|simulated)\b/i.test(message);
}
