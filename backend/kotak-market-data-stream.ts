/** Maintains a user's Kotak market-data WebSocket and decodes incoming prices. No orders.
 * Exchange timestamps are opaque in the published protocol. Keep their exact integer text;
 * never claim an arrival timestamp proves a quote is fresh enough to simulate execution.
 */
import { z } from "zod";

const exchanges = [
  "none",
  "nse_cm",
  "nse_fo",
  "cde_fo",
  "nse_com",
  "bse_cm",
  "bse_fo",
  "bse_cd",
  "bse_co",
  "mcx_fo",
  "ncd_co",
] as const;
// Kotak message IDs and packet sizes come from its native_batch protocol, not app settings.
const MARKET_STATUS_MESSAGE = 105;
const AUCTION_REFERENCE_MESSAGE = 104;
const INDEX_PRICE_MESSAGE = 7207;
const AUTHENTICATION_SUCCEEDED = 1117;
const AUTHENTICATION_INITIAL_VALUES = 1119;
const AUTHENTICATION_FAILED = 1120;
const SUBSCRIPTION_ACKNOWLEDGEMENT = 1109;
const VIEWER_IDLE_TIMEOUT_MS = 45_000;
const AUTHENTICATION_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;

/** Check the packet layout before reading any field. Status/index messages take priority;
 * ordinary quotes share a message ID and must be distinguished by their detail level.
 */
function getMinimumPacketBytes(messageCode: number, detailLevel: number) {
  switch (messageCode) {
    case INDEX_PRICE_MESSAGE:
      return 87;
    case MARKET_STATUS_MESSAGE:
      return 16;
    case AUCTION_REFERENCE_MESSAGE:
      return 33;
    case 6511:
    case 6521:
      return 9;
  }
  if (detailLevel === 1) return 54;
  if ([2, 4, 8].includes(detailLevel)) return 144;
  return 0;
}
export const feedRequestSchema = z
  .object({
    kind: z.enum(["touchline", "mini", "depth", "indices"]),
    mode: z.enum(["subscribe", "snapshot"]).default("subscribe"),
    instruments: z
      .array(
        z
          .object({
            exchange: z.enum([
              "nse_cm",
              "nse_fo",
              "cde_fo",
              "nse_com",
              "bse_cm",
              "bse_fo",
              "bse_cd",
              "bse_co",
              "mcx_fo",
              "ncd_co",
            ]),
            instrument: z
              .string()
              .trim()
              .min(1)
              .max(80)
              .regex(/^[A-Za-z0-9 &_.-]+$/),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((subscription, ctx) => {
    if (
      new Set(
        subscription.instruments.map(
          (row) => `${row.exchange}|${row.instrument}`,
        ),
      ).size !== subscription.instruments.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate subscriptions." });
    for (const row of subscription.instruments) {
      const isIndexRequest = subscription.kind === "indices";
      const usesCashExchange = ["nse_cm", "bse_cm"].includes(row.exchange);
      const hasNumericToken = /^\d{1,15}$/.test(row.instrument);
      if (
        (isIndexRequest && !usesCashExchange) ||
        (!isIndexRequest && !hasNumericToken)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Use a cash-segment index name, or a numeric pSymbol for scrips.",
        });
    }
  });
export type FeedRequest = z.infer<typeof feedRequestSchema>;
export type FeedSocket = Pick<
  WebSocket,
  "send" | "close" | "addEventListener" | "binaryType"
>;
export type FeedSocketFactory = (url: string) => FeedSocket;
export type FeedRecord = {
  type: string;
  exchange: string;
  instrument?: string;
  [key: string]: unknown;
};

/** Decode bounded full packets with exact offsets. Truncated tails are skipped and reported;
 * zero-sized packets, unexpected bitmasks and unsafe layouts fail closed instead of looping.
 * All int64 quantities/timestamps remain strings to avoid JavaScript precision loss.
 */
export function decodeKotakBinaryFrame(
  frame: Uint8Array,
  dividers: Record<string, number> = {},
) {
  if (frame.byteLength > 1048576) throw new Error("Feed frame too large.");
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const records: FeedRecord[] = [];
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const size = bytes.readUInt16LE(offset);
    if (size < 9) throw new Error("Invalid feed packet length.");
    if (offset + size > bytes.length) break;
    const packet = bytes.subarray(offset, offset + size);
    offset += size;
    if (packet[8] !== 0) throw new Error("Unsupported feed bitmask.");
    const exchange = exchanges[packet.readInt8(4)];
    if (!exchange || exchange === "none") continue;
    const divider = dividers[exchange] ?? 100;
    if (!Number.isFinite(divider) || divider <= 0)
      throw new Error("Invalid feed divider.");
    const code = packet.readUInt16LE(2);
    const level = packet[5];
    const minimumPacketBytes = getMinimumPacketBytes(code, level);
    if (minimumPacketBytes === 0) continue;
    if (size < minimumPacketBytes) throw new Error("Short feed body.");
    const readUnsignedInt32 = (at: number) => packet.readUInt32LE(at);
    const readSignedInt32 = (at: number) => packet.readInt32LE(at);
    const readExactInt64 = (at: number) => packet.readBigInt64LE(at).toString();
    const readNullPaddedText = (at: number, length: number) =>
      packet
        .subarray(at, at + length)
        .toString("utf8")
        .split("\0")[0]
        .trim();
    const base = { exchange, level, sequence: packet[7] };
    // Offsets below include the 9-byte header. Price fields divide by the exchange's
    // price divisor; quantities and timestamps stay exact, unscaled integer strings.
    if (code === 6511 || code === 6521) {
      records.push({
        ...base,
        type: "market-status",
        statusCode: code === 6511 ? 1 : 2,
        status: code === 6511 ? "Market open" : "Market closed",
      });
    } else if (code === MARKET_STATUS_MESSAGE) {
      records.push({
        ...base,
        type: "market-status",
        statusCode: packet.readUInt16LE(9),
        status: readNullPaddedText(11, 5),
      });
    } else if (code === AUCTION_REFERENCE_MESSAGE) {
      records.push({
        ...base,
        type: "cas",
        instrument: String(readSignedInt32(9)),
        referencePriceRaw: readSignedInt32(13),
        imbalanceQuantity: readExactInt64(17),
        imbalanceAtMarket: readExactInt64(25),
      });
    } else if (code === INDEX_PRICE_MESSAGE) {
      records.push({
        ...base,
        type: "index",
        instrument: readNullPaddedText(66, 21),
        token: String(readUnsignedInt32(9)),
        open: readSignedInt32(13) / divider,
        close: readSignedInt32(17) / divider,
        high: readSignedInt32(21) / divider,
        low: readSignedInt32(25) / divider,
        ltp: readSignedInt32(29) / divider,
        exchangeTimeRaw: packet.readBigUInt64LE(33).toString(),
        yearHigh: readSignedInt32(41) / divider,
        yearLow: readSignedInt32(45) / divider,
        percentChange: readSignedInt32(49) / 100,
        change: (readSignedInt32(29) - readSignedInt32(17)) / divider,
        precision: packet[61],
      });
    } else if (level === 1) {
      records.push({
        ...base,
        type: "mini",
        instrument: String(readUnsignedInt32(9)),
        exchangeTimeRaw: readExactInt64(13),
        ltp: readUnsignedInt32(21) / divider,
        lastQuantity: readExactInt64(25),
        closeRaw: readUnsignedInt32(33),
        percentChange: readSignedInt32(37) / 100,
        change: readSignedInt32(41) / divider,
        lotSize: readUnsignedInt32(45),
        precision: packet[49],
        multiplier: readUnsignedInt32(50),
      });
    } else {
      // Touchline packets always carry one bid and one ask, even when the advertised
      // counts say otherwise. Other levels use the broker's counts, bounded by packet size.
      const buyCount = level === 4 ? 1 : readUnsignedInt32(89);
      const sellCount = level === 4 ? 1 : readUnsignedInt32(93);
      const available = Math.floor((size - 144) / 16);
      const depthRowsToRead = Math.min(available, buyCount + sellCount);
      const rows = [];
      for (let index = 0; index < depthRowsToRead; index++) {
        const at = 144 + index * 16;
        rows.push({
          quantity: readExactInt64(at),
          price: readSignedInt32(at + 8) / divider,
          orders: readSignedInt32(at + 12),
        });
      }
      const tradedValue = packet.readDoubleLE(107) / divider;
      if (!Number.isFinite(tradedValue))
        throw new Error("Invalid traded value.");
      records.push({
        ...base,
        type: "quote",
        instrument: String(readUnsignedInt32(9)),
        totalBuy: readExactInt64(13),
        totalSell: readExactInt64(21),
        volume: readExactInt64(29),
        exchangeTimeRaw: readExactInt64(37),
        exchangeUpdateRaw: readExactInt64(45),
        open: readUnsignedInt32(53) / divider,
        close: readUnsignedInt32(57) / divider,
        high: readUnsignedInt32(61) / divider,
        low: readUnsignedInt32(65) / divider,
        ltp: readUnsignedInt32(69) / divider,
        lastQuantity: readExactInt64(73),
        averagePrice: readUnsignedInt32(81) / divider,
        percentChange: readSignedInt32(99) / 100,
        openInterest: readUnsignedInt32(103),
        tradedValue,
        change: readSignedInt32(115) / divider,
        upperCircuit: readUnsignedInt32(119) / divider,
        lowerCircuit: readUnsignedInt32(123) / divider,
        yearHigh: readUnsignedInt32(127) / divider,
        yearLow: readUnsignedInt32(131) / divider,
        lotSize: readUnsignedInt32(135),
        precision: packet[139],
        multiplier: readUnsignedInt32(140),
        depth: { buy: rows.slice(0, buyCount), sell: rows.slice(buyCount) },
        partialDepth: available < buyCount + sellCount,
      });
    }
  }
  return { records, truncated: offset !== bytes.length };
}

/** One bounded feed per app session. A 45-second browser lease prevents abandoned streams.
 * Reconnect is explicit: a new instance re-authenticates and re-subscribes, with no stale cache.
 * Only sanitized binary market fields leave this class; raw text acknowledgements never do.
 */
export class KotakMarketDataStream {
  private socket: FeedSocket;
  private connectionState = "connecting";
  private statusMessage = "Waiting for broker authentication.";
  private priceDividers: Record<string, number> = {};
  private latestQuotes = new Map<string, FeedRecord>();
  private notifications: FeedRecord[] = [];
  private lastViewerActivityAt = Date.now();
  private connectionStartedAt = Date.now();
  private connectionHealthTimer: ReturnType<typeof setInterval>;
  private isClosed = false;
  private isAuthenticated = false;
  private truncatedFrames = 0;

  /** Open one socket for one authenticated app session. The injected session check lets
   * logout/reconnect invalidate this stream. Tests inject a fake socket, never a live broker.
   */
  constructor(
    url: string,
    ucc: string,
    sid: string,
    private subscription: FeedRequest,
    private isSessionActive: () => boolean,
    factory: FeedSocketFactory = (url) => new WebSocket(url),
  ) {
    this.socket = factory(url);
    this.socket.binaryType = "arraybuffer";
    this.connectionHealthTimer = setInterval(() => {
      if (!isSessionActive())
        this.closeConnection(
          "session-expired",
          "Reconnect your Kotak account.",
        );
      else if (Date.now() - this.lastViewerActivityAt > VIEWER_IDLE_TIMEOUT_MS)
        this.closeConnection("stopped", "Viewer inactive; feed released.");
      else if (
        !this.isAuthenticated &&
        Date.now() - this.connectionStartedAt > AUTHENTICATION_TIMEOUT_MS
      )
        this.closeConnection(
          "error",
          "Feed authentication timed out; reconnect explicitly.",
        );
    }, HEALTH_CHECK_INTERVAL_MS);
    this.connectionHealthTimer.unref();
    this.socket.addEventListener("open", () => {
      if (this.isClosed || !isSessionActive())
        return this.closeConnection(
          "session-expired",
          "Reconnect your Kotak account.",
        );
      try {
        this.socket.send(
          JSON.stringify({
            user: ucc,
            auth: sid,
            format: "native_batch",
            source: "NEOTRADEAPI",
            platform: "Web",
            version: "1.2.3",
            sdk_version: 2,
            sdk_date: "2026-08-07T09:41:17.667Z",
            conn_req_time: Date.now(),
            sessionValidation: false,
          }),
        );
      } catch {
        this.closeConnection("error", "Could not send feed authentication.");
      }
    });
    this.socket.addEventListener("message", (event) => {
      if (this.isClosed) return;
      if (!isSessionActive())
        return this.closeConnection(
          "session-expired",
          "Reconnect your Kotak account.",
        );
      try {
        this.handleIncomingMessage(event.data);
      } catch {
        this.closeConnection(
          "error",
          "Invalid or unsupported broker feed response. No prices retained.",
        );
      }
    });
    this.socket.addEventListener("error", () =>
      this.closeConnection(
        "error",
        "Broker feed connection failed. Reconnect explicitly.",
      ),
    );
    this.socket.addEventListener("close", () =>
      this.closeConnection(
        "disconnected",
        "Broker feed closed. Reconnect to re-authenticate and subscribe.",
      ),
    );
  }

  /** Authenticate first; ticks may precede subscription acknowledgements, but not auth success. */
  private handleIncomingMessage(data: unknown) {
    if (typeof data === "string") {
      this.handleBrokerControlMessage(data);
      return;
    }
    this.updateQuotesFromBinaryFrame(data);
  }

  /** Authentication and subscription acknowledgements are JSON, not price updates.
   * Never pass raw control messages to the UI: they may contain session information.
   */
  private handleBrokerControlMessage(data: string) {
    if (Buffer.byteLength(data) > 65536)
      throw new Error("Control frame too large.");
    const row = z
      .object({ message_code: z.number().int() })
      .passthrough()
      .parse(JSON.parse(data));
    if (row.message_code === AUTHENTICATION_FAILED)
      return this.closeConnection(
        "authentication-failed",
        "Broker rejected feed authentication; reconnect your account.",
      );
    if (
      [AUTHENTICATION_SUCCEEDED, AUTHENTICATION_INITIAL_VALUES].includes(
        row.message_code,
      )
    ) {
      const auth = z
        .object({
          format: z.literal("native_batch").optional(),
          exchanges: z.record(
            z.string(),
            z.object({ divider: z.number().positive().finite() }),
          ),
        })
        .parse(row);
      this.priceDividers = {};
      for (const exchange of exchanges) {
        const settings = auth.exchanges[exchange];
        if (settings) this.priceDividers[exchange] = settings.divider;
      }
      // Official SFeed SDK accepts 1117 and production response 1119 as auth success.
      if (!this.isAuthenticated) {
        this.isAuthenticated = true;
        this.sendSubscriptionCommand(this.subscription.mode);
      }
    } else if (
      row.message_code === SUBSCRIPTION_ACKNOWLEDGEMENT &&
      row.error_code != null &&
      row.error_code !== 0
    ) {
      this.closeConnection(
        "error",
        "Broker rejected the subscription. Check segment, token and entitlements.",
      );
    }
  }

  /** Keep only subscribed instruments. Arrival time measures connection activity, not
   * exchange freshness, so these cached prices must never be used to match paper orders.
   */
  private updateQuotesFromBinaryFrame(data: unknown) {
    if (!(data instanceof ArrayBuffer))
      throw new Error("Unexpected binary feed.");
    if (!this.isAuthenticated) return; // The documented feed may send binary frames before auth.
    if (this.connectionState === "unsubscribed") return;
    const decoded = decodeKotakBinaryFrame(
      new Uint8Array(data),
      this.priceDividers,
    );
    if (decoded.truncated) this.truncatedFrames++;
    const requested = new Set(
      this.subscription.instruments.map(
        (row) => `${row.exchange}|${row.instrument}`,
      ),
    );
    for (const record of decoded.records) {
      const entry = {
        ...record,
        receivedAt: Date.now(),
        freshnessVerified: false,
      };
      if (record.type === "market-status" || record.type === "cas") {
        if (
          record.type === "cas" &&
          !requested.has(`${record.exchange}|${record.instrument}`)
        )
          continue;
        this.notifications = [...this.notifications.slice(-19), entry];
      } else if (requested.has(`${record.exchange}|${record.instrument}`)) {
        this.latestQuotes.set(`${record.exchange}|${record.instrument}`, entry);
      }
    }
  }

  /** The selected set is immutable per feed: no unbounded accumulation of subscriptions. */
  sendSubscriptionCommand(action: "subscribe" | "unsubscribe" | "snapshot") {
    if (!this.isSessionActive() || this.isClosed || !this.isAuthenticated)
      throw new Error("Feed is not authenticated.");
    const suffix = {
      indices: "Indices",
      depth: "Depth",
      touchline: "Scrips",
      mini: "ScripsLite",
    }[this.subscription.kind];
    this.socket.send(
      JSON.stringify({
        event: `${action}${suffix}`,
        inputtoken: this.subscription.instruments
          .map((row) => `${row.exchange}|${row.instrument}`)
          .join(","),
        ack_symbol: true,
      }),
    );
    this.lastViewerActivityAt = Date.now();
    const requestedState = {
      subscribe: "subscription-requested",
      snapshot: "snapshot-requested",
      unsubscribe: "unsubscribed",
    };
    this.connectionState = requestedState[action];
    this.statusMessage =
      "Indicative feed only; exchange timestamp units are unverified. Not used for paper fills.";
    if (action === "unsubscribe") this.latestQuotes.clear();
  }

  /** Polling reads only this memory cache and renews the viewer lease, never broker REST. */
  getLatestSnapshot() {
    if (!this.isSessionActive())
      this.closeConnection("session-expired", "Reconnect your Kotak account.");
    this.lastViewerActivityAt = Date.now();
    return {
      state: this.connectionState,
      kind: this.subscription.kind,
      mode: this.subscription.mode,
      detail: this.statusMessage,
      truncatedFrames: this.truncatedFrames,
      instruments: this.subscription.instruments,
      records: [...this.latestQuotes.values()].map((record) => ({
        ...record,
        receivedRecently: Date.now() - Number(record.receivedAt) <= 15000,
      })),
      notifications: this.notifications,
    };
  }

  /** Idempotent cleanup discards prices and socket access on logout, expiry, error or shutdown. */
  closeConnection(state = "stopped", detail = "Feed stopped.") {
    if (this.isClosed) return;
    this.isClosed = true;
    this.connectionState = state;
    this.statusMessage = detail;
    clearInterval(this.connectionHealthTimer);
    this.latestQuotes.clear();
    this.notifications = [];
    try {
      this.socket.close();
    } catch {
      /* A failed handshake may already be closed. */
    }
  }
}
