/** ICICI Breeze normalization for the read-only Overview dashboard. */
import { requestApiJson } from "../../../lib/api";
import { portfolioContractLabel } from "../../portfolio/portfolio-model";
import {
  calculatePositionPnl,
  type AccountSnapshot,
  type BrokerAccountAdapter,
} from "../account-model";

type WireRow = Record<string, unknown>;
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const iciciAccountAdapter: BrokerAccountAdapter = {
  id: "icici",
  name: "ICICI Direct",
  supportsStreamingPrices: false,
  async loadConnectionStatus() {
    const status = await requestApiJson("/brokers/icici");
    if (typeof status.connected !== "boolean") {
      throw new Error("ICICI Direct connection status is unavailable.");
    }
    return status.connected;
  },
  async loadLiveAccount(csrf) {
    const reports = await requestApiJson(
      "/brokers/icici/overview",
      "POST",
      {},
      csrf,
      30000,
    );
    const validRows = (value: unknown): WireRow[] | null =>
      Array.isArray(value) &&
      value.every(
        (row) =>
          row &&
          typeof row === "object" &&
          numberOrNull((row as WireRow).quantity) !== null,
      )
        ? (value as WireRow[])
        : null;
    const positions = validRows(reports.positions?.rows);
    const holdings = validRows(reports.holdings?.rows);
    const snapshot: AccountSnapshot = {
      mode: "live",
      capturedAt: numberOrNull(reports.observedAt) ?? Date.now(),
      availableFunds: numberOrNull(reports.limits?.rows?.[0]?.available),
      pnl: null,
      positions:
        positions
          ?.filter((row) => row.quantity !== 0)
          .map((row, index) => ({
            id: `${row.exchange}|${row.instrumentToken}|${index}`,
            instrument: String(row.instrumentToken ?? ""),
            exchange: String(row.exchange ?? ""),
            symbol: portfolioContractLabel({
              symbol: String(row.symbol ?? "Unknown contract"),
              expiry: String(row.expiry ?? ""),
              strike: String(row.strike ?? ""),
              right: String(row.right ?? ""),
              product: String(row.product ?? ""),
            }),
            quantity: row.quantity as number,
            averagePrice: numberOrNull(row.averagePrice),
            markPrice: numberOrNull(row.markPrice),
            pnl: numberOrNull(row.pnl),
            pnlBase: null,
            pnlPerMark: null,
            markedAt: null,
          })) ?? null,
      holdings:
        holdings?.map((row, index) => ({
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
        })) ?? null,
      warnings: [
        reports.limits?.error,
        reports.positions?.error,
        reports.holdings?.error,
        "ICICI Breeze does not expose MCX positions.",
      ].filter(
        (message): message is string =>
          typeof message === "string" && Boolean(message),
      ),
    };
    return { ...snapshot, pnl: calculatePositionPnl(snapshot) };
  },
  async startPositionFeed() {},
  async readPriceTicks() {
    return [];
  },
};
