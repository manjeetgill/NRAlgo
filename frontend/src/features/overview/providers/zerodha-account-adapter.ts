/**
 * Zerodha account normalization for the read-only Overview dashboard.
 * The adapter uses broker-reported snapshot values; Zerodha streaming is not
 * wired into the shared market-data provider yet, so no cross-broker ticks are read.
 */
import { requestApiJson } from "../../../lib/api";
import {
  calculatePositionPnl,
  type AccountSnapshot,
  type BrokerAccountAdapter,
} from "../account-model";

type WireRow = Record<string, unknown>;

/** Preserve missing or malformed money values as unknown. */
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const zerodhaAccountAdapter: BrokerAccountAdapter = {
  id: "zerodha",
  name: "Zerodha Kite",
  supportsStreamingPrices: false,
  /** Read the current OAuth session without refreshing broker account data. */
  async loadConnectionStatus() {
    const status = await requestApiJson("/brokers/zerodha");
    if (typeof status.connected !== "boolean") {
      throw new Error("Zerodha connection status is unavailable.");
    }
    return status.connected;
  },
  /** Fetch margin and open positions once from the authenticated Kite account. */
  async loadLiveAccount(csrf) {
    const reports = await requestApiJson(
      "/brokers/zerodha/overview",
      "POST",
      {},
      csrf,
      30000,
    );
    const rows: WireRow[] | null =
      Array.isArray(reports.positions?.rows) &&
      reports.positions.rows.every(
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
        /** A missing total quantity makes the complete demat book unverifiable. */ (
          row: WireRow | null,
        ) =>
          row !== null &&
          typeof row === "object" &&
          numberOrNull(row.quantity) !== null,
      )
        ? reports.holdings.rows
        : null;
    const snapshot: AccountSnapshot = {
      mode: "live",
      capturedAt: numberOrNull(reports.observedAt) ?? Date.now(),
      availableFunds: numberOrNull(reports.limits?.rows?.[0]?.available),
      pnl: null,
      positions:
        rows
          ?.filter((row) => row.quantity !== 0)
          .map((row, index) => ({
            id: `${row.exchange}|${row.instrumentToken}|${index}`,
            instrument: String(row.instrumentToken ?? ""),
            exchange: String(row.exchange ?? ""),
            symbol: String(row.symbol ?? "Unknown contract"),
            quantity: row.quantity as number,
            averagePrice: numberOrNull(row.averagePrice),
            markPrice: numberOrNull(row.markPrice),
            pnl: numberOrNull(row.pnl),
            pnlBase: null,
            pnlPerMark: null,
            markedAt: null,
          })) ?? null,
      holdings:
        holdingRows?.map(
          /** Preserve pledged and unsettled quantities rather than folding them into total units. */ (
            row,
            index,
          ) => ({
            id: `${row.exchange}|${row.instrumentToken || row.symbol}|${index}`,
            instrument: String(row.instrumentToken ?? ""),
            exchange: String(row.exchange ?? ""),
            symbol: String(row.symbol ?? "Unknown holding"),
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
  /** Zerodha live ticks are unavailable until its market-data adapter is integrated. */
  async startPositionFeed() {},
  /** Never read another provider's shared cache for Zerodha positions. */
  async readPriceTicks() {
    return [];
  },
};
