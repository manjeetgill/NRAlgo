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
  /** Broker-reported units pledged as collateral. Null means the field was not supplied. */
  pledgedQuantity: number | null;
  /** Broker-reported unsettled/T1 units. Null means the field was not supplied. */
  t1Quantity: number | null;
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
/** Select the first broker alias that is actually present without turning omission into zero. */
function firstOptionalPortfolioNumber(...values: unknown[]) {
  const value = values.find(
    (candidate) =>
      candidate !== null && candidate !== undefined && candidate !== "",
  );
  return parseOptionalPortfolioNumber(value);
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
    const pledgedQuantity = holding
      ? firstOptionalPortfolioNumber(
          row.pledgedQuantity,
          row.pledgedQty,
          row.pledged_quantity,
          row.collateralQuantity,
          row.collateralQty,
        )
      : null;
    const t1Quantity = holding
      ? firstOptionalPortfolioNumber(row.t1Quantity, row.t1Qty, row.t1_quantity)
      : null;
    if (
      (pledgedQuantity !== null &&
        (!Number.isSafeInteger(pledgedQuantity) || pledgedQuantity < 0)) ||
      (t1Quantity !== null &&
        (!Number.isSafeInteger(t1Quantity) || t1Quantity < 0))
    ) {
      throw new Error("Invalid holding quantity breakdown");
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
      instrumentToken: holding
        ? readPortfolioDisplayText(
            row.instrumentToken ??
              row.token ??
              row.tok ??
              row.exchangeIdentifier,
          )
        : readPortfolioDisplayText(row.tok),
      quantity,
      pledgedQuantity,
      t1Quantity,
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
          ? (row.unrealisedGainLoss ??
              (() => {
                const marketValue = parseOptionalPortfolioNumber(row.mktValue);
                const holdingCost = parseOptionalPortfolioNumber(
                  row.holdingCost,
                );
                return marketValue !== null && holdingCost !== null
                  ? marketValue - holdingCost
                  : null;
              })())
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

/** Normalize Kite holdings/positions into the same safe browser contract as Kotak. */
export function normalizeZerodhaPortfolioRows(
  kind: "positions" | "holdings",
  raw: unknown,
): PortfolioRow[] {
  if (!Array.isArray(raw) || raw.length >= 10000) {
    throw new Error("Portfolio missing or potentially truncated");
  }
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid portfolio row");
    }
    const row = value as Record<string, unknown>;
    const symbol = readPortfolioDisplayText(row.tradingsymbol);
    const rawExchange = readPortfolioDisplayText(row.exchange).toUpperCase();
    const exchange =
      {
        NSE: "nse_cm",
        NFO: "nse_fo",
        BSE: "bse_cm",
        BFO: "bse_fo",
        MCX: "mcx_fo",
        CDS: "cde_fo",
      }[rawExchange] ?? rawExchange.toLowerCase();
    const reportedQuantity = parseOptionalPortfolioNumber(row.quantity);
    const instrumentToken = parseOptionalPortfolioNumber(row.instrument_token);
    const holding = kind === "holdings";
    const pledgedQuantity = holding
      ? firstOptionalPortfolioNumber(
          row.collateral_quantity,
          row.pledged_quantity,
        )
      : null;
    const t1Quantity = holding
      ? firstOptionalPortfolioNumber(row.t1_quantity)
      : null;
    const mtf =
      holding &&
      row.mtf &&
      typeof row.mtf === "object" &&
      !Array.isArray(row.mtf)
        ? (row.mtf as Record<string, unknown>)
        : null;
    const mtfQuantity = mtf
      ? (firstOptionalPortfolioNumber(mtf.quantity) ?? 0)
      : 0;
    /** Kite reports settled, collateral, T1 and MTF buckets separately. The shared
     * quantity is their complete total so collateral-only scripts are never filtered out. */
    const quantity =
      reportedQuantity === null
        ? null
        : holding
          ? reportedQuantity +
            (pledgedQuantity ?? 0) +
            (t1Quantity ?? 0) +
            mtfQuantity
          : reportedQuantity;
    if (
      !symbol ||
      !exchange ||
      quantity === null ||
      !Number.isSafeInteger(quantity) ||
      instrumentToken === null ||
      !Number.isSafeInteger(instrumentToken) ||
      instrumentToken <= 0
    ) {
      throw new Error("Missing portfolio identity/quantity");
    }
    if (
      (pledgedQuantity !== null &&
        (!Number.isSafeInteger(pledgedQuantity) || pledgedQuantity < 0)) ||
      (t1Quantity !== null &&
        (!Number.isSafeInteger(t1Quantity) || t1Quantity < 0)) ||
      !Number.isSafeInteger(mtfQuantity) ||
      mtfQuantity < 0
    ) {
      throw new Error("Invalid holding quantity breakdown");
    }
    return {
      symbol,
      instrumentToken: String(instrumentToken),
      exchange,
      product: readPortfolioDisplayText(row.product),
      quantity,
      pledgedQuantity,
      t1Quantity,
      averagePrice: parseOptionalPortfolioNumber(row.average_price),
      markPrice: parseOptionalPortfolioNumber(row.last_price),
      pnl: parseOptionalPortfolioNumber(row.pnl),
      pnlBase: null,
      pnlPerMark: null,
      expiry: "",
      right: "",
      strike: "",
    };
  });
}

/** Read Zerodha's NSE/NFO buying power without exposing the raw margin payload. */
export function normalizeZerodhaAvailableFunds(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const equity = (raw as Record<string, unknown>).equity;
  if (!equity || typeof equity !== "object" || Array.isArray(equity)) {
    return null;
  }
  const record = equity as Record<string, unknown>;
  const available = record.available;
  const candidates = [
    record.net,
    available && typeof available === "object" && !Array.isArray(available)
      ? (available as Record<string, unknown>).live_balance
      : null,
  ];
  for (const value of candidates) {
    const parsed = parseOptionalPortfolioNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}
