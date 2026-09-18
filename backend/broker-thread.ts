// The SDK contains module-global mutable variables. Never share its JS realm across accounts.
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { ResearchStreamCache } from "./research-stream.js";
import {
  createBreezeData,
  type BreezeCredentials,
  type HistoricalParams,
  type FeedParams,
} from "./breeze.js";

const port = parentPort!;
const adapter = createBreezeData(workerData as BreezeCredentials);
let researchStream: ResearchStreamCache | null = null;
/** Detach only research/data sockets. Expired browser leases cannot leave feeds running forever. */
function stopResearchStream(state = "stopped") {
  adapter.stopStreaming();
  if (researchStream) {
    researchStream.invalidate(state);
    port.postMessage({ researchStream: researchStream.snapshot() });
  }
  researchStream = null;
}
// Coalesce high-volume market ticks: at most two small, four-leg messages per second.
setInterval(() => {
  if (!researchStream) return;
  if (researchStream.leaseExpired()) {
    stopResearchStream("expired");
    return;
  }
  port.postMessage({ researchStream: researchStream.snapshot() });
}, 500).unref();
const require = createRequire(import.meta.url);
const axios = require("axios");
axios.defaults.timeout = 15000;
axios.defaults.maxContentLength = 64 * 1024 * 1024;
axios.defaults.maxBodyLength = 1024 * 1024;
// Only public market fields may leave this thread; never forward SDK errors or account data.
const allowed = new Set([
  "datetime",
  "date",
  "time",
  "symbol",
  "stock_code",
  "stock_name",
  "exchange_code",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "ltp",
  "best_bid_price",
  "best_offer_price",
  "last",
  "ltt",
  "bPrice",
  "bQty",
  "sPrice",
  "sQty",
  "ttq",
  "total_quantity_traded",
  "open_interest",
  "expiry_date",
  "strike_price",
  "right",
  "product_type",
]);
/** Strip account/order fields and cap candles so worker messages cannot expose raw SDK objects. */
function sanitizeMarketData(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 1000).map(sanitizeMarketData);
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, v]) => allowed.has(key) && ["string", "number"].includes(typeof v),
    ),
  );
}
let queue = Promise.resolve();
port.on(
  "message",
  (message: {
    id: number;
    method: string;
    params: unknown;
    streamId?: string;
  }) => {
    if (message.method === "streamHeartbeat") {
      if (researchStream && researchStream.streamId === message.streamId)
        researchStream.heartbeat();
      return;
    }
    queue = queue.then(async () => {
      try {
        let result: unknown = { ok: true };
        if (message.method === "connect") await adapter.connect();
        else if (message.method === "optionChain")
          result = sanitizeMarketData(
            await adapter.optionChain(message.params as FeedParams),
          );
        else if (message.method === "subscribeBasket") {
          stopResearchStream();
          const input = message.params as {
            streamId: string;
            strategyId: string;
            legs: FeedParams[];
          };
          const cache = new ResearchStreamCache(
            input.streamId,
            input.strategyId,
            input.legs.map((leg) => leg.stockCode!),
          );
          researchStream = cache;
          cache.heartbeat();
          await adapter.subscribeBasket(
            input.legs,
            (index, quote) => {
              if (researchStream === cache) cache.accept(index, quote);
            },
            (state) => {
              if (researchStream === cache) {
                cache.invalidate(state);
                port.postMessage({ researchStream: cache.snapshot() });
              }
            },
          );
        } else if (message.method === "stopBasket") {
          const input = message.params as { streamId: string };
          if (researchStream?.streamId === input.streamId) stopResearchStream();
        } else if (message.method === "historical")
          result = sanitizeMarketData(
            await adapter.historical(message.params as HistoricalParams),
          );
        else if (message.method === "quotes")
          result = sanitizeMarketData(
            await adapter.quotes(message.params as FeedParams),
          );
        else if (message.method === "subscribe") {
          stopResearchStream("replaced");
          // One active subscription per account; recreate to remove previous rooms/listeners.
          await adapter.connect();
          await adapter.subscribe(message.params as FeedParams, (tick) =>
            port.postMessage({ tick: sanitizeMarketData(tick) }),
          );
        } else throw new Error();
        port.postMessage({ id: message.id, result });
      } catch {
        stopResearchStream("disconnected");
        adapter.disconnect();
        port.postMessage({ id: message.id, error: true });
      }
    });
  },
);
