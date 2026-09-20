/** Converts broker positions and holdings into the fields shown in the real portfolio view.
 * Do not forward raw account identifiers, tokens or arbitrary broker fields to the browser.
 * Reject malformed/oversized books rather than silently truncating an "all positions" view.
 */
export interface PortfolioRow {
  /** Kotak's public instrument token is used server-side for a display quote. */
  instrumentToken: string;
  symbol: string;
  /** ISIN is the preferred cross-broker equity identity. Empty means unavailable. */
  isin: string;
  /** Derivative underlying when the broker supplies it. Empty means unavailable. */
  underlying: string;
  exchange: string;
  product: string;
  quantity: number;
  /** Broker-reported units pledged as collateral. Null means the field was not supplied. */
  pledgedQuantity: number | null;
  /** Broker-reported unsettled/T1 units. Null means the field was not supplied. */
  t1Quantity: number | null;
  /** Broker-reported MTF units remain separate from settled/T1/collateral buckets. */
  mtfQuantity: number | null;
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
    const totalBuyQuantity = hasPositionQuantities
      ? (parseOptionalPortfolioNumber(row.cfBuyQty) ?? 0) +
        (parseOptionalPortfolioNumber(row.flBuyQty) ?? 0)
      : null;
    const totalSellQuantity = hasPositionQuantities
      ? (parseOptionalPortfolioNumber(row.cfSellQty) ?? 0) +
        (parseOptionalPortfolioNumber(row.flSellQty) ?? 0)
      : null;
    const positionQuantity = hasPositionQuantities
      ? totalBuyQuantity! - totalSellQuantity!
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
    const mtfQuantity = holding
      ? firstOptionalPortfolioNumber(
          row.mtfQuantity,
          row.mtfQty,
          row.mtf_quantity,
        )
      : null;
    if (
      (pledgedQuantity !== null &&
        (!Number.isSafeInteger(pledgedQuantity) || pledgedQuantity < 0)) ||
      (t1Quantity !== null &&
        (!Number.isSafeInteger(t1Quantity) || t1Quantity < 0)) ||
      (mtfQuantity !== null &&
        (!Number.isSafeInteger(mtfQuantity) || mtfQuantity < 0))
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
    /** Kotak's position contract defines the open average from cash amounts and
     * quantities. `avgPrc` is not a reliable open-position cost basis. */
    const precision = holding
      ? null
      : parseOptionalPortfolioNumber(row.precision);
    if (
      precision !== null &&
      (!Number.isSafeInteger(precision) || precision < 0 || precision > 8)
    ) {
      throw new Error("Invalid position precision");
    }
    const calculatedAverageRaw =
      !holding && hasAmounts && multiplier && priceScale
        ? quantity > 0 && totalBuyQuantity
          ? buyAmount! / (totalBuyQuantity * multiplier * priceScale)
          : quantity < 0 && totalSellQuantity
            ? sellAmount! / (totalSellQuantity * multiplier * priceScale)
            : null
        : null;
    const calculatedAverage =
      calculatedAverageRaw !== null && precision !== null
        ? Number(calculatedAverageRaw.toFixed(precision))
        : calculatedAverageRaw;
    const reportedAverage = parseOptionalPortfolioNumber(
      holding ? row.averagePrice : row.avgPrc,
    );
    const reportedMark = parseOptionalPortfolioNumber(
      holding ? row.closingPrice : (row.ltp ?? row.lastTradedPrice),
    );
    const markPrice =
      reportedMark !== null && reportedMark > 0 ? reportedMark : null;
    const pnlBase = holding || !hasAmounts ? null : sellAmount! - buyAmount!;
    const pnlPerMark = holding ? null : quantity * multiplier! * priceScale!;
    const calculatedPnl =
      markPrice !== null && pnlBase !== null && pnlPerMark !== null
        ? pnlBase + markPrice * pnlPerMark
        : null;
    return {
      symbol,
      isin: readPortfolioDisplayText(
        holding ? (row.isin ?? row.isinCode ?? row.isinCd) : "",
      ).toUpperCase(),
      underlying: readPortfolioDisplayText(
        holding ? "" : (row.underlying ?? row.undSym ?? row.sym),
      ).toUpperCase(),
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
      mtfQuantity,
      exchange: readPortfolioDisplayText(
        holding ? row.exchangeSegment : row.exSeg,
      ),
      product: readPortfolioDisplayText(
        holding ? row.instrumentType : row.prod,
      ),
      averagePrice: holding
        ? reportedAverage
        : (calculatedAverage ??
          (reportedAverage !== null && reportedAverage > 0
            ? reportedAverage
            : null)),
      markPrice,
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
          : (calculatedPnl ??
              row.unrealisedGainLoss ??
              row.unrealizedPnl ??
              row.unrealizedPnL),
      ),
      pnlBase,
      pnlPerMark,
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
    const averagePrice = parseOptionalPortfolioNumber(row.average_price);
    const markPrice = parseOptionalPortfolioNumber(row.last_price);
    const reportedPnl = parseOptionalPortfolioNumber(row.pnl);
    return {
      symbol,
      isin: readPortfolioDisplayText(row.isin).toUpperCase(),
      underlying: readPortfolioDisplayText(row.underlying).toUpperCase(),
      instrumentToken: String(instrumentToken),
      exchange,
      product: readPortfolioDisplayText(row.product),
      quantity,
      pledgedQuantity,
      t1Quantity,
      mtfQuantity: holding ? mtfQuantity : null,
      averagePrice,
      markPrice,
      pnl:
        reportedPnl ??
        (holding && averagePrice !== null && markPrice !== null
          ? (markPrice - averagePrice) * quantity
          : null),
      pnlBase: null,
      pnlPerMark: null,
      expiry: "",
      right: "",
      strike: "",
    };
  });
}

/** Normalize Breeze NSE/NFO books; unsupported MCX rows fail closed instead of disappearing. */
export function normalizeIciciPortfolioRows(
  kind: "positions" | "holdings",
  raw: unknown,
): PortfolioRow[] {
  if (!Array.isArray(raw) || raw.length >= 10000) {
    throw new Error("ICICI Direct portfolio missing or potentially truncated");
  }
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid ICICI Direct portfolio row");
    }
    const row = value as Record<string, unknown>;
    const exchangeCode = readPortfolioDisplayText(
      row.exchange_code,
    ).toUpperCase();
    if (!exchangeCode || !["NSE", "NFO"].includes(exchangeCode)) {
      throw new Error(
        "ICICI Direct Breeze supports only NSE and NFO portfolio rows",
      );
    }
    const symbol = readPortfolioDisplayText(
      row.stock_code || row.stock_name,
    ).toUpperCase();
    const quantity = firstOptionalPortfolioNumber(
      row.quantity,
      row.open_quantity,
      row.available_quantity,
    );
    if (!symbol || quantity === null || !Number.isSafeInteger(quantity)) {
      throw new Error("Missing ICICI Direct portfolio identity/quantity");
    }
    const averagePrice = firstOptionalPortfolioNumber(
      row.average_price,
      row.avg_price,
    );
    const markPrice = firstOptionalPortfolioNumber(
      row.current_market_price,
      row.ltp,
    );
    const pnl = firstOptionalPortfolioNumber(
      row.unrealized_profit,
      row.unrealised_profit,
      row.profit_loss,
    );
    return {
      symbol,
      isin: readPortfolioDisplayText(row.isin_code || row.isin).toUpperCase(),
      underlying: kind === "positions" ? symbol : "",
      instrumentToken: readPortfolioDisplayText(
        row.token || row.instrument_token || `${exchangeCode}:${symbol}`,
      ),
      exchange: exchangeCode === "NFO" ? "nse_fo" : "nse_cm",
      product: readPortfolioDisplayText(row.product_type || row.product),
      quantity,
      pledgedQuantity:
        kind === "holdings"
          ? firstOptionalPortfolioNumber(
              row.pledged_quantity,
              row.blocked_quantity,
            )
          : null,
      t1Quantity:
        kind === "holdings"
          ? firstOptionalPortfolioNumber(
              row.t1_quantity,
              row.unsettled_quantity,
            )
          : null,
      mtfQuantity:
        kind === "holdings"
          ? firstOptionalPortfolioNumber(row.mtf_quantity)
          : null,
      averagePrice,
      markPrice,
      pnl:
        pnl ??
        (averagePrice !== null && markPrice !== null
          ? (markPrice - averagePrice) * quantity
          : null),
      pnlBase: null,
      pnlPerMark: null,
      expiry: readPortfolioDisplayText(row.expiry_date),
      right: readPortfolioDisplayText(row.right),
      strike: readPortfolioDisplayText(row.strike_price),
    };
  });
}

/** Broker-neutral funds keep buying power distinct from cash and collateral. */
export interface NormalizedFunds {
  availableMargin: number | null;
  cashBalance: number | null;
  usedMargin: number | null;
  collateralValue: number | null;
  /** Account-wide open-position MTM when the broker reports it with limits. */
  positionMtm: number | null;
}

/** Normalize Breeze limits while keeping cash, collateral and buying power distinct. */
export function normalizeIciciFunds(raw: unknown): NormalizedFunds {
  const rows = Array.isArray(raw) ? raw : [raw];
  const row = rows.find((value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  if (!row) {
    return {
      availableMargin: null,
      cashBalance: null,
      usedMargin: null,
      collateralValue: null,
      positionMtm: null,
    };
  }
  return {
    availableMargin: firstOptionalPortfolioNumber(
      row.total_bank_balance,
      row.available_margin,
      row.limit_available,
    ),
    cashBalance: firstOptionalPortfolioNumber(
      row.cash_balance,
      row.bank_balance,
    ),
    usedMargin: firstOptionalPortfolioNumber(
      row.margin_used,
      row.blocked_margin,
    ),
    collateralValue: firstOptionalPortfolioNumber(
      row.collateral_value,
      row.pledged_collateral,
    ),
    positionMtm: firstOptionalPortfolioNumber(
      row.unrealized_profit,
      row.unrealised_profit,
      row.mtm,
    ),
  };
}

/** Read Zerodha's NSE/NFO margin breakdown without exposing the raw payload. */
export function normalizeZerodhaFunds(raw: unknown): NormalizedFunds {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      availableMargin: null,
      cashBalance: null,
      usedMargin: null,
      collateralValue: null,
      positionMtm: null,
    };
  }
  const equity = (raw as Record<string, unknown>).equity;
  if (!equity || typeof equity !== "object" || Array.isArray(equity)) {
    return {
      availableMargin: null,
      cashBalance: null,
      usedMargin: null,
      collateralValue: null,
      positionMtm: null,
    };
  }
  const record = equity as Record<string, unknown>;
  const available =
    record.available &&
    typeof record.available === "object" &&
    !Array.isArray(record.available)
      ? (record.available as Record<string, unknown>)
      : null;
  const utilised =
    record.utilised &&
    typeof record.utilised === "object" &&
    !Array.isArray(record.utilised)
      ? (record.utilised as Record<string, unknown>)
      : null;
  const candidates = [record.net, available?.live_balance];
  let availableMargin: number | null = null;
  for (const value of candidates) {
    const parsed = parseOptionalPortfolioNumber(value);
    if (parsed !== null) {
      availableMargin = parsed;
      break;
    }
  }
  return {
    availableMargin,
    cashBalance: firstOptionalPortfolioNumber(
      available?.cash,
      available?.opening_balance,
      available?.live_balance,
    ),
    usedMargin: firstOptionalPortfolioNumber(utilised?.debits, utilised?.span),
    collateralValue: firstOptionalPortfolioNumber(
      available?.collateral,
      available?.adhoc_margin,
    ),
    positionMtm: null,
  };
}

/** Compatibility helper for account cards that only need current buying power. */
export function normalizeZerodhaAvailableFunds(raw: unknown): number | null {
  return normalizeZerodhaFunds(raw).availableMargin;
}
