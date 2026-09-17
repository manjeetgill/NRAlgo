// SERVER ONLY. Do not import breezeconnect directly elsewhere: its published
// module disables TLS verification at import time. Restore it synchronously.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function loadBreeze() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must be enabled.');
  try { return require('breezeconnect').BreezeConnect; }
  finally { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'; }
}

// Data-only integration boundary; deliberately no order methods or HTTP routes.
// Credentials come from server configuration, never NEXT_PUBLIC_* or browser code.
export function createBreezeData({ apiKey, apiSecret, sessionToken }, Client = loadBreeze()) {
  if (![apiKey, apiSecret, sessionToken].every(v => typeof v === 'string' && v.length)) throw new Error('Breeze credentials are required.');
  const sdk = new Client({ appKey: apiKey });
  let connected = false;
  return {
    async connect() {
      connected = false;
      try { await sdk.generateSession(apiSecret, sessionToken); connected = true; }
      catch { throw new Error('Breeze authentication failed. Reconnect through the broker login.'); }
    },
    async historical(params) {
      if (!connected) throw new Error('Connect to Breeze first.');
      try {
        const result = await sdk.getHistoricalDatav2(params);
        if (result?.Error || Number(result?.Status) !== 200) throw new Error();
        return result.Success;
      } catch { throw new Error('Breeze historical data request failed.'); }
    },
    async subscribe(params, onTicks) {
      if (!connected) throw new Error('Connect to Breeze first.');
      sdk.onTicks = onTicks;
      sdk.wsConnect();
      try { return await sdk.subscribeFeeds({ ...params, getOrderNotification: false }); }
      catch { throw new Error('Breeze feed subscription failed.'); }
    },
    disconnect() {
      for (const socket of [sdk.socket, sdk.socketOrder, sdk.socketOHLCV]) socket?.disconnect();
      connected = false;
    },
  };
}
