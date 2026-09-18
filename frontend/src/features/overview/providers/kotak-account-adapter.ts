/** Kotak wire normalization lives here, not in the Overview screen or shared model.
 * Adding a broker means implementing BrokerAccountAdapter and registering it once. */
import { requestApiJson } from "../../../lib/api";
import { calculatePositionPnl } from "../overview-model";
import type {
  AccountPosition,
  AccountSnapshot,
  BrokerAccountAdapter,
} from "../overview-types";

type WireRow = Record<string, unknown>;
/** Only finite server numbers represent known balances; missing values stay null. */
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** Convert the paper ledger's integer paise to the screen's INR display contract. */
const rupeesFromPaise = (value: unknown) => {
  const amount = numberOrNull(value);
  return amount === null ? null : amount / 100;
};

export const kotakAccountAdapter: BrokerAccountAdapter = {
  id: "kotak",
  name: "Kotak Neo",
  /** GET reads authentication state only; no virtual account, quotes or execution are requested. */
  async loadConnectionStatus() {
    const status = await requestApiJson("/brokers/kotak/status");
    if (typeof status.connected !== "boolean") {
      throw new Error("Broker connection status is unavailable.");
    }
    return status.connected;
  },
  /** Load the existing virtual ledger and connection flag without matching or sending orders. */
  async loadPaperAccount() {
    // GET reads the virtual ledger (lazily initialized by the server); no broker execution.
    const wallet = await requestApiJson("/paper/kotak");
    if (
      !wallet.positions ||
      typeof wallet.positions !== "object" ||
      Array.isArray(wallet.positions) ||
      typeof wallet.connected !== "boolean"
    ) {
      throw new Error("Paper account response is incomplete.");
    }
    // Flat positions are omitted; stale paper valuations remain unknown.
    const positions: AccountPosition[] = Object.entries(
      wallet.positions,
    ).flatMap(
      /** Normalize each ledger entry; reject malformed units instead of inventing zero. */ ([
        id,
        raw,
      ]) => {
        if (
          !raw ||
          typeof raw !== "object" ||
          numberOrNull((raw as WireRow).quantity) === null
        ) {
          throw new Error("Paper position quantity is unavailable.");
        }
        const position = raw as { quantity: number; costPaise: number };
        if (!position.quantity) {
          return [];
        }
        const mark = wallet.marks?.[id];
        const markPrice = rupeesFromPaise(mark?.bid);
        const cost = rupeesFromPaise(position.costPaise);
        return [
          {
            id,
            instrument: id,
            exchange: "paper",
            symbol: id,
            quantity: position.quantity,
            averagePrice: cost === null ? null : cost / position.quantity,
            markPrice,
            pnl:
              numberOrNull(wallet.unrealizedPaise) === null ||
              markPrice === null ||
              cost === null
                ? null
                : markPrice * position.quantity - cost,
            pnlBase: null,
            pnlPerMark: null,
            markedAt: numberOrNull(mark?.observedAt),
          },
        ];
      },
    );
    // Reservations reduce available cash, but never change the recorded all-time paper P&L.
    const cash = rupeesFromPaise(wallet.cashPaise),
      reserved = rupeesFromPaise(wallet.reservedPaise);
    const realized = rupeesFromPaise(wallet.realizedPaise),
      unrealized = rupeesFromPaise(wallet.unrealizedPaise);
    return {
      connected: wallet.connected === true,
      snapshot: {
        mode: "paper",
        availableFunds:
          cash === null || reserved === null ? null : cash - reserved,
        pnl:
          realized === null || unrealized === null
            ? null
            : realized + unrealized,
        positions,
        capturedAt: Date.now(),
        warnings:
          unrealized === null
            ? [
                "Paper marks are stale or incomplete. Refresh them in Paper trading.",
              ]
            : [],
      },
    };
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
    // Carry immutable valuation coefficients forward for token-matched streaming marks.
    const snapshot: AccountSnapshot = {
      mode: "live",
      capturedAt: numberOrNull(reports.observedAt) ?? Date.now(),
      availableFunds: numberOrNull(reports.limits?.rows?.[0]?.available),
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
      warnings: [reports.limits?.error, reports.positions?.error].filter(
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
