/** Kotak wire normalization lives here, not in the Overview screen or shared model.
 * Adding a broker means implementing BrokerAccountAdapter and registering it once. */
import { requestApiJson } from "../../../lib/api";
import { portfolioContractLabel } from "../../portfolio/portfolio-model";
import {
  calculatePositionPnl,
  type AccountSnapshot,
  type BrokerAccountAdapter,
} from "../account-model";

type WireRow = Record<string, unknown>;
/** Only finite server numbers represent known balances; missing values stay null. */
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const kotakAccountAdapter: BrokerAccountAdapter = {
  id: "kotak",
  name: "Kotak Neo",
  supportsStreamingPrices: true,
  /** GET reads authentication state only; no quotes or execution are requested. */
  async loadConnectionStatus() {
    const status = await requestApiJson("/brokers/kotak/status");
    if (typeof status.connected !== "boolean") {
      throw new Error("Broker connection status is unavailable.");
    }
    return status.connected;
  },
  /** Fetch one snapshot, preserving partial failures instead of assuming an empty account. */
  async loadLiveAccount(csrf) {
    // POST is a CSRF-protected read: limits and positions only, not orders/trades or execution.
    // The extended timeout accommodates the broker's serialized report/initial quote reads.
    const reports = await requestApiJson(
      "/brokers/kotak/overview",
      "POST",
      {},
      csrf,
      95000,
    );
    const rows: WireRow[] | null =
      Array.isArray(reports.positions?.rows) &&
      reports.positions.rows.every(
        /** An unknown quantity must not silently turn a potentially open position into a flat one. */
        (row: WireRow | null) =>
          row !== null &&
          typeof row === "object" &&
          numberOrNull(row.quantity) !== null,
      )
        ? reports.positions.rows
        : null;
    const holdingRows: WireRow[] | null =
      Array.isArray(reports.holdings?.rows) &&
      reports.holdings.rows.every(
        /** Do not treat malformed holdings as an empty demat book. */ (
          row: WireRow | null,
        ) =>
          row !== null &&
          typeof row === "object" &&
          numberOrNull(row.quantity) !== null,
      )
        ? reports.holdings.rows
        : null;
    // Carry immutable valuation coefficients forward for token-matched streaming marks.
    const snapshot: AccountSnapshot = {
      mode: "live",
      capturedAt: numberOrNull(reports.observedAt) ?? Date.now(),
      availableFunds: numberOrNull(reports.limits?.rows?.[0]?.available),
      reportedUnrealizedPnl: numberOrNull(
        reports.limits?.rows?.[0]?.unrealizedPnl,
      ),
      pnl: null,
      positions:
        rows
          ?.filter(
            /** Closed positions do not contribute to the open-position headline. */ (
              row,
            ) => row.quantity !== 0,
          )
          .map(
            /** Preserve the broker's valuation coefficients for subsequent price-only updates. */ (
              row,
              index,
            ) => ({
              id: `${row.exchange}|${row.instrumentToken}|${index}`,
              instrument: String(row.instrumentToken ?? ""),
              exchange: String(row.exchange ?? ""),
              symbol: String(row.symbol ?? "Unknown contract"),
              quantity: row.quantity as number,
              averagePrice: numberOrNull(row.averagePrice),
              markPrice: numberOrNull(row.markPrice),
              pnl:
                numberOrNull(row.markPrice) === null
                  ? null
                  : numberOrNull(row.pnl),
              pnlBase: numberOrNull(row.pnlBase),
              pnlPerMark: numberOrNull(row.pnlPerMark),
              markedAt: null,
            }),
          ) ?? null,
      holdings:
        holdingRows?.map(
          /** Keep broker-reported pledge/T1 fields nullable when Kotak omits them. */ (
            row,
            index,
          ) => ({
            id: `${row.exchange}|${row.instrumentToken || row.symbol}|${index}`,
            instrument: String(row.instrumentToken ?? ""),
            exchange: String(row.exchange ?? ""),
            symbol: portfolioContractLabel({
              symbol: String(row.symbol ?? "Unknown holding"),
              expiry: String(row.expiry ?? ""),
              strike: String(row.strike ?? ""),
              right: String(row.right ?? ""),
              product: String(row.product ?? ""),
            }),
            product: String(row.product ?? ""),
            quantity: row.quantity as number,
            pledgedQuantity: numberOrNull(row.pledgedQuantity),
            t1Quantity: numberOrNull(row.t1Quantity),
            averagePrice: numberOrNull(row.averagePrice),
            markPrice: numberOrNull(row.markPrice),
            pnl: numberOrNull(row.pnl),
          }),
        ) ?? null,
      warnings: [
        reports.limits?.error,
        reports.positions?.error,
        reports.holdings?.error,
      ].filter(
        /** Only server-supplied readable errors belong in the user-facing warning list. */
        (message): message is string =>
          typeof message === "string" && Boolean(message),
      ),
    };
    if (rows === null && !reports.positions?.error) {
      snapshot.warnings.push(
        "Position data is incomplete; the account is not assumed empty.",
      );
    }
    if (holdingRows === null && !reports.holdings?.error) {
      snapshot.warnings.push(
        "Holding data is incomplete; the demat account is not assumed empty.",
      );
    }
    return { ...snapshot, pnl: calculatePositionPnl(snapshot) };
  },
  /** Start the shared price subscription. Returning the promise leaves waiting to the hook. */
  startPositionFeed(csrf) {
    // POST subscribes the server's cached open-position tokens; the screen never sends orders.
    return requestApiJson("/market/live-feed", "POST", {}, csrf);
  },
  /** Read the server's tick cache only; this does not refetch broker account reports. */
  async readPriceTicks() {
    // The provider-neutral endpoint keeps Overview independent from Kotak route names.
    const feed = await requestApiJson("/market/feed");
    return (Array.isArray(feed.records) ? feed.records : []).map(
      /** Invalid prices/times stay non-finite so the pure valuation model rejects them. */
      (row: WireRow) => ({
        instrument: String(row.instrument ?? ""),
        exchange: String(row.exchange ?? ""),
        price: numberOrNull(row.ltp) ?? NaN,
        receivedAt: numberOrNull(row.receivedAt) ?? NaN,
        fresh: row.receivedRecently === true,
      }),
    );
  },
};
