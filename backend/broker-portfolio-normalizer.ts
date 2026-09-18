/** Converts broker positions and holdings into the fields shown in the real portfolio view.
 * Do not forward raw account identifiers, tokens or arbitrary broker fields to the browser.
 * Reject malformed/oversized books rather than silently truncating an "all positions" view.
 */
export interface PortfolioRow {
  /** Kotak's public instrument token is used server-side for a display quote. */
  instrumentToken: string;
  symbol: string;
  exchange: string;
  product: string;
  quantity: number;
  averagePrice: number | null;
  markPrice: number | null;
  pnl: number | null;
  /** Server-only terms for Kotak's documented P&L formula. */
  pnlBase: number | null;
  pnlPerMark: number | null;
  expiry: string;
  right: string;
  strike: string;
}
/** Preserve fractional averages; missing optional values are unknown, never fabricated zero. */
function parseOptionalPortfolioNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (
    !["number", "string"].includes(typeof value) ||
    !Number.isFinite(Number(value))
  ) {
    throw new Error("Invalid portfolio number");
  }
  return Number(value);
}
/** Keep display text short and return an empty label when the broker omitted it. */
function readPortfolioDisplayText(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, 120)
    : "";
}

/** Normalize the full Kotak book; missing optional money values remain unknown. */
export function normalizePortfolioRows(
  kind: "positions" | "holdings",
  raw: unknown,
): PortfolioRow[] {
  if (!Array.isArray(raw) || raw.length >= 10000) {
    throw new Error("Portfolio missing or potentially truncated");
  }
  return raw.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Invalid portfolio row");
    }
    const holding = kind === "holdings";
    const symbol = readPortfolioDisplayText(
      holding ? row.displaySymbol || row.symbol : row.trdSym || row.sym,
    );
    const hasPositionQuantities =
      !holding &&
      ["cfBuyQty", "flBuyQty", "cfSellQty", "flSellQty"].some(
        (key) => row[key] !== undefined,
      );
    const positionQuantity = hasPositionQuantities
      ? (parseOptionalPortfolioNumber(row.cfBuyQty) ?? 0) +
        (parseOptionalPortfolioNumber(row.flBuyQty) ?? 0) -
        (parseOptionalPortfolioNumber(row.cfSellQty) ?? 0) -
        (parseOptionalPortfolioNumber(row.flSellQty) ?? 0)
      : parseOptionalPortfolioNumber(row.qty);
    const quantity = holding
      ? parseOptionalPortfolioNumber(row.quantity)
      : positionQuantity;
    if (!symbol || quantity === null || !Number.isSafeInteger(quantity)) {
      throw new Error("Missing portfolio identity/quantity");
    }
    const multiplier = holding
      ? null
      : (parseOptionalPortfolioNumber(row.multiplier) ?? 1);
    const priceScale = holding
      ? null
      : (((parseOptionalPortfolioNumber(row.genNum) ?? 1) /
          (parseOptionalPortfolioNumber(row.genDen) ?? 1)) *
          (parseOptionalPortfolioNumber(row.prcNum) ?? 1)) /
        (parseOptionalPortfolioNumber(row.prcDen) ?? 1);
    const buyAmount = holding
      ? null
      : (parseOptionalPortfolioNumber(row.cfBuyAmt) ?? 0) +
        (parseOptionalPortfolioNumber(row.buyAmt) ?? 0);
    const sellAmount = holding
      ? null
      : (parseOptionalPortfolioNumber(row.cfSellAmt) ?? 0) +
        (parseOptionalPortfolioNumber(row.sellAmt) ?? 0);
    const hasAmounts = ["cfBuyAmt", "buyAmt", "cfSellAmt", "sellAmt"].some(
      (key) => row[key] !== null && row[key] !== undefined && row[key] !== "",
    );
    if (
      !holding &&
      (!Number.isFinite(priceScale) ||
        !priceScale ||
        !Number.isFinite(multiplier) ||
        !multiplier)
    ) {
      throw new Error("Invalid position scaling");
    }
    return {
      symbol,
      instrumentToken: holding ? "" : readPortfolioDisplayText(row.tok),
      quantity,
      exchange: readPortfolioDisplayText(
        holding ? row.exchangeSegment : row.exSeg,
      ),
      product: readPortfolioDisplayText(
        holding ? row.instrumentType : row.prod,
      ),
      averagePrice: parseOptionalPortfolioNumber(
        holding
          ? row.averagePrice
          : (row.avgPrc ??
              (() => {
                const openAmount =
                  quantity > 0
                    ? (parseOptionalPortfolioNumber(row.cfBuyAmt) ?? 0) +
                      (parseOptionalPortfolioNumber(row.buyAmt) ?? 0)
                    : (parseOptionalPortfolioNumber(row.cfSellAmt) ?? 0) +
                      (parseOptionalPortfolioNumber(row.sellAmt) ?? 0);
                const sideQuantity =
                  quantity > 0
                    ? (parseOptionalPortfolioNumber(row.cfBuyQty) ?? 0) +
                      (parseOptionalPortfolioNumber(row.flBuyQty) ?? 0)
                    : (parseOptionalPortfolioNumber(row.cfSellQty) ?? 0) +
                      (parseOptionalPortfolioNumber(row.flSellQty) ?? 0);
                return sideQuantity && multiplier && priceScale
                  ? openAmount / (sideQuantity * multiplier * priceScale)
                  : null;
              })()),
      ),
      markPrice: parseOptionalPortfolioNumber(
        holding ? row.closingPrice : (row.ltp ?? row.lastTradedPrice),
      ),
      pnl: parseOptionalPortfolioNumber(
        holding
          ? row.unrealisedGainLoss
          : (row.unrealisedGainLoss ?? row.unrealizedPnl ?? row.unrealizedPnL),
      ),
      pnlBase: holding || !hasAmounts ? null : sellAmount! - buyAmount!,
      pnlPerMark: holding ? null : quantity * multiplier! * priceScale!,
      expiry: readPortfolioDisplayText(holding ? row.expiryDate : row.expDt),
      right: readPortfolioDisplayText(holding ? row.optType : row.optTp),
      strike: readPortfolioDisplayText(holding ? row.strikePrice : row.stkPrc),
    };
  });
}
