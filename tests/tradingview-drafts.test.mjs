import assert from "node:assert/strict";
import test from "node:test";
import { receiveTradingViewAlert } from "../backend/tradingview-routes.ts";
import { digest } from "../backend/security.ts";

function fixture() {
  const secret = "a".repeat(43);
  const drafts = [];
  const store = {
    async transaction(work) {
      return work(async (sql, params = []) => {
        if (sql.startsWith("SELECT user_id,secret_hash")) {
          return params[0] === digest(secret)
            ? [{ user_id: "user-1", secret_hash: digest(secret) }]
            : [];
        }
        if (sql.startsWith("INSERT INTO tradingview_order_drafts")) {
          const draft = {
            id: params[0],
            userId: params[1],
            externalAlertId: params[2],
            symbol: params[3],
            market: params[4],
            side: params[5],
            orderType: params[6],
            quantity: params[7],
            limitPaise: params[8],
          };
          if (
            drafts.some(
              (existing) =>
                existing.userId === draft.userId &&
                existing.externalAlertId === draft.externalAlertId,
            )
          ) {
            return [];
          }
          drafts.push(draft);
          return [{ id: draft.id }];
        }
        if (
          sql.startsWith("INSERT INTO events") ||
          sql.startsWith("DELETE FROM events")
        ) {
          return [];
        }
        throw new Error(`Unexpected test query: ${sql}`);
      });
    },
    async close() {},
  };
  return { store, drafts, secret };
}

test("TradingView receiver creates one non-executable draft and deduplicates retries", async () => {
  const { store, drafts, secret } = fixture();
  const body = {
    alertId: "ema-NSE:NIFTY-2026-09-20T09:15:00Z",
    symbol: "NSE:NIFTY",
    market: "OPTIONS",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 50,
    limitPrice: 251.25,
    strategy: "EMA crossover",
    triggeredAt: "2026-09-20T09:15:00Z",
  };
  assert.equal(await receiveTradingViewAlert(store, secret, body), true);
  assert.equal(await receiveTradingViewAlert(store, secret, body), true);
  assert.deepEqual(drafts, [
    {
      id: drafts[0].id,
      userId: "user-1",
      externalAlertId: "ema-NSE:NIFTY-2026-09-20T09:15:00Z",
      symbol: "NSE:NIFTY",
      market: "options",
      side: "buy",
      orderType: "limit",
      quantity: 50,
      limitPaise: 25125,
    },
  ]);
});

test("TradingView receiver rejects unknown keys and malformed order drafts", async () => {
  const { store, drafts, secret } = fixture();
  assert.equal(await receiveTradingViewAlert(store, "b".repeat(43), {}), false);
  await assert.rejects(() =>
    receiveTradingViewAlert(store, secret, {
      alertId: "bad-market",
      symbol: "NSE:NIFTY",
      market: "CASH",
      side: "BUY",
      orderType: "MARKET",
      quantity: 1,
      limitPrice: 100,
      triggeredAt: "2026-09-20T09:15:00Z",
    }),
  );
  assert.equal(drafts.length, 0);
});
