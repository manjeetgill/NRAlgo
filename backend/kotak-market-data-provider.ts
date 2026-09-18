/** Kotak wire formats and master-file discovery stay behind this adapter. */
import type { KotakMarketDataClient } from "./kotak-market-data-client.js";
import { InstrumentCatalog } from "./instrument-master.js";
import type { MarketDataProvider } from "./market-data-provider.js";

/** Adapt Kotak reads to the provider contract without exposing order placement. */
export function createKotakMarketDataProvider(
  client: KotakMarketDataClient,
  catalog = new InstrumentCatalog(),
): MarketDataProvider {
  /** Bind Kotak's catalog namespace inside the adapter so application routes stay provider-neutral. */
  const instruments: MarketDataProvider["instruments"] = {
    isFresh: (market) => catalog.isFresh("kotak", market),
    search: (input) => catalog.search("kotak", input),
    resolve: (market, identity) =>
      catalog.resolveResearch("kotak", market, identity),
    validate: (input, quantity) => catalog.validate("kotak", input, quantity),
  };
  return {
    id: "kotak",
    capabilities: {
      live: true,
      historyIntervals: ["1minute", "5minute", "day"],
      requiresBrokerConnection: true,
    },
    instruments,
    isConnected: (user, session) => client.isConnected(user, session),
    /** Load an allowlisted master only when the requested segment cache is stale. */
    async prepareInstruments(session, market, reserve) {
      if (!client.isConnected(session.userId, session.sessionHash)) {
        throw Object.assign(new Error("Connect Kotak first."), {
          status: 409,
          detail: "Connect Kotak first.",
        });
      }
      if (catalog.isFresh("kotak", market)) {
        return;
      }
      await reserve();
      await reserve();
      await catalog.load(
        "kotak",
        market,
        await client.getInstrumentMasterUrl(
          session.userId,
          session.sessionHash,
          market,
        ),
      );
      if (!client.isConnected(session.userId, session.sessionHash)) {
        throw Object.assign(new Error("Kotak disconnected."), {
          status: 409,
          detail: "Kotak disconnected during instrument discovery.",
        });
      }
    },
    getPaperFillQuote: (...args) => client.getPaperFillQuote(...args),
    getQuoteSnapshots: (...args) => client.getQuoteSnapshots(...args),
    getHistoricalCandlesForDay: (...args) =>
      client.getHistoricalCandlesForDay(...args),
    /** Map application interval/segment names only here; the client validates the bounded broker response. */
    async getHistoricalCandles(userId, sessionHash, request, signal) {
      const result = await client.fetchMarketData(
        userId,
        sessionHash,
        {
          operation: "history",
          exchange: request.market === "cash" ? "nse_cm" : "nse_fo",
          instrument: request.instrument,
          from: request.from,
          to: request.to,
          interval: { "1minute": "1min", "5minute": "5min", day: "D" }[
            request.interval
          ] as "1min" | "5min" | "D",
        },
        signal,
      );
      if (!("candles" in result)) {
        throw new Error("Historical response unavailable.");
      }
      return result.candles.map((candle) => ({
        ...candle,
        timestamp: new Date(
          candle.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"),
        ).toISOString(),
      }));
    },
    startPriceFeed: (...args) => client.startMarketDataStream(...args),
    readPriceFeed: (...args) => client.getMarketDataStreamSnapshot(...args),
    stopPriceFeed: (...args) => client.stopMarketDataStream(...args),
    disconnect: (user) => client.disconnect(user),
    close: () => client.close(),
  };
}
