/** Isolated official Breeze SDK realm for one execution account. No raw broker errors/logs
 * leave this thread. SDK transport is corrected for DELETE bodies, bounded, TLS-verified,
 * redirect-free and retry-free; an ambiguous placement is never retried here.
 */
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { loadBreeze, type BreezeCredentials } from "../breeze.js";

interface ExecutionSdk {
  userId: string;
  generateSession(secret: string, token: string): Promise<unknown>;
  makeRequest: (
    method: string,
    endpoint: string,
    body: unknown,
    headers: unknown,
  ) => Promise<unknown>;
  [key: string]: unknown;
}
/** Correct the installed SDK's axios.delete(url, body, config) argument bug. Retain its
 * signing code and endpoint methods; send the exact same JSON that its checksum signs.
 */
export function configureExecutionTransport(
  sdk: ExecutionSdk,
  request: (config: Record<string, unknown>) => Promise<unknown>,
) {
  sdk.makeRequest = async (method, endpoint, body, headers) => {
    const permitted =
      (method === "GET" &&
        [
          "customerdetails",
          "funds",
          "margin",
          "order",
          "trades",
          "portfoliopositions",
          "quotes",
        ].includes(endpoint)) ||
      (["POST", "DELETE"].includes(method) && endpoint === "order");
    if (!permitted) throw new Error("Unsupported execution operation");
    return request({
      method: method.toLowerCase(),
      url: `https://api.icicidirect.com/breezeapi/api/v1/${endpoint}`,
      data: JSON.stringify(body),
      headers,
      timeout: 1800,
      maxRedirects: 0,
      maxContentLength: 4 * 1024 * 1024,
      maxBodyLength: 65536,
      proxy: false,
    });
  };
}

if (parentPort) {
  const port = parentPort,
    creds = workerData as BreezeCredentials;
  const Sdk = loadBreeze();
  const sdk = new Sdk({ appKey: creds.apiKey }) as unknown as ExecutionSdk;
  const require = createRequire(import.meta.url),
    axios = require("axios");
  configureExecutionTransport(sdk, axios);
  let connected = false,
    queue = Promise.resolve();
  const methods = new Set([
    "getFunds",
    "getMargin",
    "getOrderList",
    "getTradeList",
    "getPortfolioPositions",
    "getQuotes",
    "placeOrder",
    "cancelOrder",
  ]);
  port.on(
    "message",
    (message: { id: number; method: string; params?: unknown }) => {
      queue = queue.then(async () => {
        try {
          let result: unknown;
          if (message.method === "connect") {
            await sdk.generateSession(creds.apiSecret, creds.sessionToken);
            if (!sdk.userId) throw new Error("Authentication failed");
            connected = true;
            result = {
              binding: `icici:${createHash("sha256").update(sdk.userId).digest("hex")}`,
            };
          } else {
            if (!connected || !methods.has(message.method))
              throw new Error("Operation unavailable");
            if (message.method === "placeOrder") {
              const p = message.params as Record<string, unknown>;
              if (
                p.exchangeCode !== "NSE" ||
                p.product !== "cash" ||
                p.orderType !== "limit" ||
                p.validity !== "day"
              )
                throw new Error("Unsupported live order");
            }
            result = await (
              sdk[message.method] as (params?: unknown) => Promise<unknown>
            )(message.params);
          }
          port.postMessage({ id: message.id, result });
        } catch {
          port.postMessage({ id: message.id, error: true });
        }
      });
    },
  );
}
