// SERVER ONLY. Do not import breezeconnect directly elsewhere: its published
// module disables TLS verification at import time. Restore it synchronously.
import { createRequire } from "node:module";
import { decodeResearchTick, type ResearchQuote } from "./research-stream.js";
import { normalizePortfolioRows } from "./portfolio-model.js";
const require = createRequire(import.meta.url);
export interface BreezeCredentials {
  apiKey: string;
  apiSecret: string;
  sessionToken: string;
}
export interface HistoricalParams {
  interval: "1second" | "1minute" | "5minute" | "30minute" | "1day";
  fromDate: string;
  toDate: string;
  stockCode: string;
  exchangeCode: string;
  productType?: string;
  expiryDate?: string;
  right?: string;
  strikePrice?: string;
}
export interface FeedParams {
  stockToken?: string;
  exchangeCode?: string;
  stockCode?: string;
  productType?: string;
  expiryDate?: string;
  strikePrice?: string;
  right?: string;
  interval?: string;
  getExchangeQuotes?: boolean;
  getMarketDepth?: boolean;
  getOrderNotification?: boolean;
}
interface Socket {
  emit?(event: string, value: unknown): void;
  disconnect(): void;
  on?(event: string, listener: (value?: unknown) => void): void;
  removeAllListeners?(event?: string): void;
}
interface BreezeClient {
  getPortfolioPositions(): Promise<{
    Status?: number | string;
    Error?: unknown;
    Success?: unknown;
  }>;
  getDematHoldings(): Promise<{
    Status?: number | string;
    Error?: unknown;
    Success?: unknown;
  }>;
  generateHeaders(body: Record<string, string>): unknown;
  makeRequest(
    method: string,
    endpoint: string,
    body: Record<string, string>,
    headers: unknown,
  ): Promise<{
    data: { Status?: number | string; Error?: unknown; Success?: unknown };
  }>;
  getOptionChainQuotes(
    params: FeedParams,
  ): Promise<{ Status?: number | string; Error?: unknown; Success?: unknown }>;
  getStockTokenValue(params: FeedParams): { exch_quote_token: string | false };
  getQuotes(
    params: FeedParams,
  ): Promise<{ Status?: number | string; Error?: unknown; Success?: unknown }>;
  generateSession(secret: string, token: string): Promise<unknown>;
  getHistoricalDatav2(
    params: HistoricalParams,
  ): Promise<{ Status?: number | string; Error?: unknown; Success?: unknown }>;
  subscribeFeeds(params: FeedParams): Promise<unknown>;
  wsConnect(): void;
  onTicks: ((tick: unknown) => void) | null;
  socket?: Socket;
  socketOrder?: Socket;
  socketOHLCV?: Socket;
}
type BreezeConstructor = new (params: { appKey: string }) => BreezeClient;
/** SDK 1.0.31's getOptionChainQuotes uses `exchange != NFO || exchange != BFO`,
 * which rejects every exchange. Keep its signing/transport but strictly allow only this
 * fixed read-only NSE-options endpoint; never patch node_modules or expose arbitrary HTTP.
 */
export async function requestNfoOptionChain(
  sdk: Pick<BreezeClient, "generateHeaders" | "makeRequest">,
  params: FeedParams,
) {
  if (
    params.exchangeCode !== "NFO" ||
    params.productType !== "options" ||
    !params.stockCode ||
    !params.expiryDate ||
    !["call", "put"].includes(params.right || "")
  )
    throw new Error("Invalid option-chain request.");
  const body = {
    stock_code: params.stockCode,
    exchange_code: "NFO",
    expiry_date: params.expiryDate,
    product_type: "options",
    right: params.right!,
  };
  const response = await sdk.makeRequest(
    "GET",
    "optionchain",
    body,
    sdk.generateHeaders(body),
  );
  return response.data;
}
/** Import the official SDK without allowing its module-level TLS override to remain active. */
export function loadBreeze(): BreezeConstructor {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS verification must be enabled.");
  try {
    return require("breezeconnect").BreezeConnect;
  } finally {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  }
}

// Data-only integration boundary; deliberately no order methods or HTTP routes.
// Credentials come from server configuration, never NEXT_PUBLIC_* or browser code.
/** Expose data-only SDK capabilities. A fresh SDK instance is created for every reconnection.
 * generateSession exchanges API_Session for the API token; the SDK builds v1/v2 headers itself.
 */
export function createBreezeData(
  { apiKey, apiSecret, sessionToken }: BreezeCredentials,
  Client = loadBreeze(),
) {
  if (
    ![apiKey, apiSecret, sessionToken].every(
      (v) => typeof v === "string" && v.length,
    )
  )
    throw new Error("Breeze credentials are required.");
  let sdk = new Client({ appKey: apiKey });
  let connected = false;
  /** Stop quote sockets without discarding authenticated REST state or touching any live account. */
  const stopStreaming = () => {
    for (const socket of [sdk.socket, sdk.socketOrder, sdk.socketOHLCV]) {
      socket?.removeAllListeners?.();
      socket?.disconnect();
    }
    sdk.socket = undefined;
    sdk.socketOrder = undefined;
    sdk.socketOHLCV = undefined;
  };
  /** Remove listeners before closing sockets so explicit disconnects cannot reconnect accidentally. */
  const disconnect = () => {
    stopStreaming();
    connected = false;
  };
  return {
    stopStreaming,
    /** Fetch unfiltered broker positions or demat holdings without exposing execution methods. */
    async portfolio(kind: "positions" | "holdings") {
      if (!connected) throw new Error("Connect to Breeze first.");
      try {
        const result =
          kind === "positions"
            ? await sdk.getPortfolioPositions()
            : await sdk.getDematHoldings();
        if (Number(result?.Status) !== 200 || result?.Error) throw new Error();
        return normalizePortfolioRows("icici", kind, result.Success);
      } catch {
        throw new Error(
          "ICICI portfolio unavailable. Verify the connected account.",
        );
      }
    },
    /** Fetch one call/put chain through the data-only SDK surface; redact all broker errors. */
    async optionChain(params: FeedParams) {
      if (!connected) throw new Error("Connect to Breeze first.");
      try {
        const result = await requestNfoOptionChain(sdk, params);
        if (
          result?.Error ||
          Number(result?.Status) !== 200 ||
          !Array.isArray(result.Success)
        )
          throw new Error();
        return result.Success;
      } catch {
        throw new Error("Breeze option-chain request failed.");
      }
    },
    /** One quote socket for up to four exact instrument-master tokens. Use the SDK connection
     * and token lookup, but one raw listener avoids duplicate SDK watch handlers and preserves
     * exchange epochs. No order-notification room is joined. Reconnect clears old prices first.
     */
    async subscribeBasket(
      params: FeedParams[],
      onTick: (index: number, quote: ResearchQuote) => void,
      onState: (state: string) => void,
    ) {
      if (!connected) throw new Error("Connect to Breeze first.");
      if (params.length < 1 || params.length > 4)
        throw new Error("Invalid basket size.");
      stopStreaming();
      try {
        const tokens = params.map(
          (item) =>
            sdk.getStockTokenValue({
              ...item,
              getExchangeQuotes: true,
              getMarketDepth: false,
            }).exch_quote_token,
        );
        if (
          tokens.some(
            (token) => !token || !/^4\.1!\d+$/.test(token as string),
          ) ||
          new Set(tokens).size !== tokens.length
        )
          throw new Error();
        sdk.wsConnect();
        const socket = sdk.socket;
        if (!socket?.on || !socket.emit) throw new Error();
        const join = () => {
          onState("waiting");
          for (const token of tokens) socket.emit!("join", token);
        };
        socket.on("stock", (raw: unknown) => {
          if (!Array.isArray(raw)) return;
          const index = tokens.indexOf(raw[0]);
          if (index < 0) return;
          const quote = decodeResearchTick(
            raw,
            tokens[index] as string,
            params[index].productType || "cash",
            params[index].stockCode || "",
          );
          if (quote) onTick(index, quote);
        });
        socket.on("connect", join);
        socket.on("disconnect", () => onState("disconnected"));
        socket.on("connect_error", () => onState("disconnected"));
        join();
      } catch {
        stopStreaming();
        onState("disconnected");
        throw new Error("Breeze basket subscription failed.");
      }
    },
    /** Authenticate on the server. Raw SDK exceptions are redacted because they may contain secrets. */
    async connect() {
      disconnect();
      sdk = new Client({ appKey: apiKey });
      try {
        await sdk.generateSession(apiSecret, sessionToken);
        connected = true;
      } catch {
        throw new Error(
          "Breeze authentication failed. Reconnect through the broker login.",
        );
      }
    },
    /** Request historical-v2 candles and reject broker-level errors even when HTTP succeeded. */
    async historical(params: HistoricalParams) {
      if (!connected) throw new Error("Connect to Breeze first.");
      try {
        const result = await sdk.getHistoricalDatav2(params);
        if (result?.Error || Number(result?.Status) !== 200) throw new Error();
        return result.Success;
      } catch {
        throw new Error("Breeze historical data request failed.");
      }
    },
    /** Read one contract's top-of-book quote. This data-only adapter still has no order methods. */
    async quotes(params: FeedParams) {
      if (!connected) throw new Error("Connect to Breeze first.");
      try {
        const result = await sdk.getQuotes(params);
        if (result?.Error || Number(result?.Status) !== 200) throw new Error();
        return result.Success;
      } catch {
        throw new Error("Breeze quote request failed.");
      }
    },
    /** Subscribe to market quotes, then rejoin the requested room when Socket.IO reconnects. */
    async subscribe(params: FeedParams, onTicks: (tick: unknown) => void) {
      if (!connected) throw new Error("Connect to Breeze first.");
      sdk.onTicks = onTicks;
      try {
        sdk.wsConnect();
        const subscription = { ...params, getOrderNotification: false };
        const result = await sdk.subscribeFeeds(subscription);
        // The server loses rooms on reconnect. Replace SDK data listeners, then rejoin.
        for (const socket of [sdk.socket, sdk.socketOHLCV])
          socket?.on?.("connect", () => {
            socket.removeAllListeners?.("stock");
            void sdk.subscribeFeeds(subscription).catch(() => disconnect());
          });
        return result;
      } catch {
        throw new Error("Breeze feed subscription failed.");
      }
    },
    disconnect,
  };
}
