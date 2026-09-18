/** Kotak wire formats and master-file discovery stay behind this adapter. */
import type { KotakMarketDataClient } from "./kotak-market-data-client.js";
import { InstrumentCatalog } from "./instrument-master.js";
import type { MarketDataProvider } from "./market-data-provider.js";

export function createKotakMarketDataProvider(
  client: KotakMarketDataClient,
  catalog = new InstrumentCatalog(),
): MarketDataProvider {
  return {
    id: "kotak",
    capabilities: {
      live: true,
      historyIntervals: ["1minute", "5minute"],
      requiresBrokerConnection: true,
      instrumentNamespace: "kotak",
    },
    instruments: catalog,
    isConnected: (user, session) => client.isConnected(user, session),
    async prepareInstruments(session, market, reserve) {
      if (!client.isConnected(session.userId, session.sessionHash))
        throw Object.assign(new Error("Connect Kotak first."), {
          status: 409,
          detail: "Connect Kotak first.",
        });
      if (catalog.isFresh("kotak", market)) return;
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
      if (!client.isConnected(session.userId, session.sessionHash))
        throw Object.assign(new Error("Kotak disconnected."), {
          status: 409,
          detail: "Kotak disconnected during instrument discovery.",
        });
    },
    getPaperFillQuote: (...args) => client.getPaperFillQuote(...args),
    getQuoteSnapshots: (...args) => client.getQuoteSnapshots(...args),
    getHistoricalCandlesForDay: (...args) =>
      client.getHistoricalCandlesForDay(...args),
    startPriceFeed: (...args) => client.startMarketDataStream(...args),
    readPriceFeed: (...args) => client.getMarketDataStreamSnapshot(...args),
    stopPriceFeed: (...args) => client.stopMarketDataStream(...args),
    disconnect: (user) => client.disconnect(user),
    close: () => client.close(),
  };
}
