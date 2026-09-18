/** Network-free Kotak data fixture. Any unlisted endpoint fails, including order submission. */
import { KotakMarketDataClient } from "../../dist/backend/kotak-market-data-client.js";
export const fakeKotakLogin = {
  accessToken: "fake-token-only",
  mobileNumber: "+919999999999",
  ucc: "FAKE",
  totp: "123456",
  mpin: "123456",
};
export function fakeKotakData(calls = [], socketFactory) {
  return new KotakMarketDataClient(async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith("/tradeApiLogin")) {
      return {
        data: { status: "success", kType: "View", token: "view", sid: "sid" },
      };
    }
    if (url.endsWith("/tradeApiValidate")) {
      return {
        data: {
          status: "success",
          kType: "Trade",
          token: "trade",
          sid: "sid",
          baseUrl: "https://e43.kotaksecurities.com",
          ...(socketFactory
            ? { feedUrl: "https://e43.kotaksecurities.com/apifeed" }
            : {}),
        },
      };
    }
    if (!url.startsWith("https://e43.kotaksecurities.com/")) {
      throw new Error("Unexpected fake host");
    }
    if (url.endsWith("/masterscrip/file-paths")) {
      return {
        data: {
          filesPaths: [
            "transformed-v1/nse_cm-v1.csv",
            "transformed/nse_fo.csv",
          ].map(
            (path) =>
              `https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/${path}`,
          ),
        },
      };
    }
    if (url.includes("/quotes/")) {
      return decodeURIComponent(url.split("/neosymbol/")[1].split("/")[0])
        .split(",")
        .map((pair) => {
          const [exchange, exchange_token] = pair.split("|");
          return {
            exchange,
            exchange_token,
            ltp: "101",
            lstup_time: String(Date.now() / 1000),
            open_int: "50",
            last_volume: "10",
            depth: { buy: [{ price: "100" }], sell: [{ price: "102" }] },
          };
        });
    }
    if (url.includes("/watchlist/expiries?")) {
      const query = new URL(url).searchParams;
      return {
        exchange: query.get("exchange"),
        underlying: query.get("underlying"),
        expiries: ["2026-09-24"],
      };
    }
    if (url.includes("/watchlist/option-chain?")) {
      const query = new URL(url).searchParams;
      return {
        data: {
          common_data: {
            mktLot: "25",
            multiplier: "1",
            unlSymbol: query.get("underlying"),
            exSeg: query.get("exchange"),
            expiryDt: "2026-09-24",
          },
          call: [
            {
              instrument: {
                neoSymbol: "nse_fo|123",
                symbol: "TEST26SEP25000CE",
                optionType: "CE",
                strikePrice: "25000",
              },
              quote: { ltp: "101", close: null },
              openInterest: {
                current: 50,
                previous: 40,
                change: 10,
                changePct: 25,
              },
            },
          ],
          put: [],
        },
      };
    }
    if (url.includes("/historical/details?")) {
      const params = new URL(url).searchParams,
        day = params.get("fromdate");
      const start = Date.parse(`${day}T09:15:00+05:30`);
      return {
        status: "success",
        interval: "5min",
        data: {
          candles: Array.from({ length: 75 }, (_, i) => [
            new Date(start + i * 300000).toISOString().replace(".000Z", "Z"),
            100 + i,
            105 + i,
            99 + i,
            102 + i,
            10,
            null,
          ]),
        },
      };
    }
    if (url.endsWith("/quick/user/positions")) {
      return {
        stat: "ok",
        stCode: 200,
        data: [
          { trdSym: "REAL-KOTAK", qty: "-25", exSeg: "nse_fo", prod: "NRML" },
        ],
      };
    }
    if (url.endsWith("/portfolio/v1/holdings")) {
      return {
        data: [
          { displaySymbol: "REAL-HOLDING", quantity: 7, averagePrice: 100 },
        ],
      };
    }
    if (url.endsWith("/quick/user/limits")) {
      return { stat: "Ok", Net: "12345", MarginUsed: "20" };
    }
    if (
      url.endsWith("/quick/user/orders") ||
      url.endsWith("/quick/user/trades")
    ) {
      return {
        stat: "Ok",
        data: [
          {
            nOrdNo: "FAKE-1",
            trdSym: "REAL-KOTAK",
            exSeg: "nse_fo",
            qty: "25",
            fldQty: "25",
            prc: "102",
            avgPrc: "102",
            trnsTp: "B",
            ordSt: "complete",
          },
        ],
      };
    }
    throw new Error("Unexpected broker endpoint: " + new URL(url).pathname);
  }, socketFactory);
}

/** Browser smoke feed: asynchronous protocol events only, with no real WebSocket construction. */
export function fakeIndexFeedSocket(url) {
  if (url !== "wss://e43.kotaksecurities.com/apifeed") {
    throw new Error("Unexpected fake feed host.");
  }
  return new (class extends EventTarget {
    binaryType = "arraybuffer";
    closed = false;
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    /** Return known auth/control packets and one fixed index tick; reject every other action. */
    send(message) {
      const row = JSON.parse(message);
      if (row.format === "native_batch") {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                message_code: 1117,
                format: "native_batch",
                exchanges: { nse_cm: { divider: 100 } },
              }),
            }),
          ),
        );
        return;
      }
      if (
        !["subscribeIndices", "snapshotIndices", "unsubscribeIndices"].includes(
          row.event,
        ) ||
        row.inputtoken !== "nse_cm|Nifty 50"
      ) {
        throw new Error("Unexpected fake feed control.");
      }
      if (row.event === "unsubscribeIndices") {
        return;
      }
      const packet = Buffer.alloc(87);
      packet.writeUInt16LE(87);
      packet.writeUInt16LE(7207, 2);
      packet[4] = 1;
      packet.writeInt32LE(2412345, 29);
      packet.writeInt32LE(2400000, 17);
      packet.write("Nifty 50", 66);
      queueMicrotask(() => {
        if (!this.closed) {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: Uint8Array.from(packet).buffer,
            }),
          );
        }
      });
    }
    /** Mark closed without opening any external connection. */
    close() {
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
  })();
}
