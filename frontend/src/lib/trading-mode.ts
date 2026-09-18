/** Presentation policy shared by the shell and Overview. It never grants execution permission. */
export type TradingMode = "paper" | "live";

/** Only an explicit server boolean enables the simulated workspace; missing settings mean live-only. */
export function getTradingMode(paperTradingEnabled: unknown): TradingMode {
  return paperTradingEnabled === true ? "paper" : "live";
}

/** Hide complete workflows rather than just their sidebar labels. These screens currently simulate orders. */
export function isTradingPageVisible(page: string, mode: TradingMode): boolean {
  const paperPages = [
    "Strategies",
    "Strategy lab",
    "Broker paper",
    "Orders & trades",
    "Learn the stack",
  ];
  return mode === "paper"
    ? page !== "Live trading"
    : !paperPages.includes(page);
}

/** Legacy audit rows lack a mode column. Hide explicitly simulated/research messages in live views only.
 * The durable audit is untouched; account/security and broker events remain available. */
export function isTradingEventVisible(
  message: string,
  mode: TradingMode,
): boolean {
  return (
    mode === "paper" ||
    !/\b(paper|simulated|simulation|replay|research)\b/i.test(message)
  );
}
