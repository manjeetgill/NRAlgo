/** Read-only broker portfolio normalization, independent of paper balances and real execution.
 * Do not forward raw account identifiers, tokens or arbitrary broker fields to the browser.
 * Reject malformed/oversized books rather than silently truncating an "all positions" view.
 */
export interface PortfolioRow {
  symbol: string;
  exchange: string;
  product: string;
  quantity: number;
  averagePrice: number | null;
  markPrice: number | null;
  pnl: number | null;
  expiry: string;
  right: string;
  strike: string;
}
/** Preserve fractional averages; missing optional values are unknown, never fabricated zero. */
function optionalNumber(value: unknown) {
  if (value == null || value === "") return null;
  if (
    !["number", "string"].includes(typeof value) ||
    !Number.isFinite(Number(value))
  )
    throw new Error("Invalid portfolio number");
  return Number(value);
}
function label(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, 120)
    : "";
}
/** Normalize full returned books across segments; zero quantities remain visible as closed positions. */
export function normalizePortfolioRows(
  broker: "icici" | "kotak",
  kind: "positions" | "holdings",
  raw: unknown,
): PortfolioRow[] {
  if (!Array.isArray(raw) || raw.length >= 10000)
    throw new Error("Portfolio missing or potentially truncated");
  return raw.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("Invalid portfolio row");
    const kotak = broker === "kotak",
      holding = kind === "holdings";
    const symbol = label(
      kotak
        ? holding
          ? row.displaySymbol || row.symbol
          : row.trdSym || row.sym
        : row.stock_code,
    );
    let quantity = optionalNumber(kotak && !holding ? row.qty : row.quantity);
    if (!symbol || quantity === null || !Number.isSafeInteger(quantity))
      throw new Error("Missing portfolio identity/quantity");
    if (!kotak && !holding && String(row.action).toLowerCase() === "sell")
      quantity = -Math.abs(quantity);
    return {
      symbol,
      quantity,
      exchange: label(
        kotak ? (holding ? row.exchangeSegment : row.exSeg) : row.exchange_code,
      ),
      product: label(
        kotak
          ? holding
            ? row.instrumentType
            : row.prod
          : row.product_type || (holding ? "Demat" : ""),
      ),
      averagePrice: optionalNumber(
        kotak ? (holding ? row.averagePrice : null) : row.average_price,
      ),
      markPrice: optionalNumber(
        kotak
          ? holding
            ? row.closingPrice
            : null
          : (row.ltp ?? row.current_market_price),
      ),
      pnl: optionalNumber(
        kotak
          ? holding
            ? row.unrealisedGainLoss
            : null
          : (row.pnl ?? row.unrealized_profit),
      ),
      expiry: label(
        kotak ? (holding ? row.expiryDate : row.expDt) : row.expiry_date,
      ),
      right: label(kotak ? (holding ? row.optType : row.optTp) : row.right),
      strike: label(
        kotak ? (holding ? row.strikePrice : row.stkPrc) : row.strike_price,
      ),
    };
  });
}
