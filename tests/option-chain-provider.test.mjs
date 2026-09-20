import test from "node:test";
import assert from "node:assert/strict";
import { createKotakMarketDataProvider } from "../backend/kotak-market-data-provider.ts";

/** Native Kotak chain data is normalized once at the provider boundary. */
test("Kotak native option chain preserves missing depth and exact contract identity", async () => {
  const requests = [];
  const client = {
    async fetchMarketData(_userId, _sessionHash, request) {
      requests.push(request);
      if (request.operation === "expiries") {
        return {
          exchange: "nse_fo",
          underlying: "NIFTY",
          expiries: ["2099-01-29", "2099-02-26"],
        };
      }
      return {
        common_data: {
          mktLot: 65,
          multiplier: 1,
          unlSymbol: "NIFTY",
          exSeg: "nse_fo",
          expiryDt: "2099-01-29",
        },
        call: [
          {
            instrument: {
              neoSymbol: "nse_fo|101",
              symbol: "NIFTY99JAN25000CE",
              optionType: "CE",
              strikePrice: 25000,
            },
            quote: {
              ltp: 125,
              open: 100,
              high: 130,
              low: 90,
              prevClose: 110,
              close: null,
              volume: 500,
            },
            openInterest: {
              current: 1000,
              previous: 900,
              change: 100,
              changePct: 11.11,
            },
          },
        ],
        put: [
          {
            instrument: {
              neoSymbol: "nse_fo|102",
              symbol: "NIFTY99JAN25000PE",
              optionType: "PE",
              strikePrice: 25000,
            },
            quote: {
              ltp: null,
              open: null,
              high: null,
              low: null,
              prevClose: null,
              close: null,
              volume: null,
            },
            openInterest: {
              current: null,
              previous: null,
              change: null,
              changePct: null,
            },
          },
        ],
        observedAt: null,
        indicative: true,
        note: "No exchange timestamp.",
      };
    },
  };
  const provider = createKotakMarketDataProvider(client);
  assert.deepEqual(
    await provider.getOptionExpiries("owner", "session", "NIFTY"),
    ["2099-01-29", "2099-02-26"],
  );
  const chain = await provider.getOptionChain("owner", "session", {
    underlying: "NIFTY",
    expiryDate: "2099-01-29",
    count: 100,
  });
  assert.equal(chain.items.length, 2);
  assert.deepEqual(
    chain.items.map((row) => [
      row.instrument,
      row.option.right,
      row.price,
      row.bid,
      row.ask,
      row.change,
      row.stale,
    ]),
    [
      ["101", "call", 125, null, null, 15, true],
      ["102", "put", null, null, null, null, true],
    ],
  );
  assert.equal(chain.items[0].masterToken, "kotak:options:101");
  assert.equal(chain.items[0].lotSize, 65);
  assert.deepEqual(
    requests.map((request) => request.operation),
    ["expiries", "chain"],
  );
});
