/** Authenticated, quota-limited historical reads shared by Backtest Studio and option charts. */
import type { Express } from "express";
import type { Store } from "./database.js";
import type { BrokerRequestCoordinator } from "./broker-data-access.js";
import type { MarketDataProvider } from "./market-data-provider.js";
import {
  historicalRequestSchema,
  validateHistoricalCandles,
} from "./historical-market-data.js";
import { reserveBrokerRequestBudget } from "./strategy-research-routes.js";
import { fail, rateLimit } from "./security.js";

/** Mount after global session/CSRF checks; identity is always taken from the authenticated session. */
export function registerHistoricalMarketDataRoutes(
  app: Express,
  store: Store,
  coordinator: BrokerRequestCoordinator,
  provider: MarketDataProvider,
  production: boolean,
) {
  app.post(
    "/api/market/history",
    rateLimit(20, 60000, (req) => req.res!.locals.session.user_id),
    async (req, res) => {
      const input = historicalRequestSchema.parse(req.body);
      const session = res.locals.session;
      if (!provider.capabilities.historyIntervals.includes(input.interval)) {
        fail(
          422,
          "The selected market-data provider does not support this historical interval.",
        );
      }
      await coordinator.runExclusiveForUser(session.user_id, async () => {
        if (!provider.isConnected(session.user_id, session.token_hash)) {
          fail(
            409,
            "Connect the market-data provider under Broker connections before loading history.",
          );
        }
        await provider.prepareInstruments(
          { userId: session.user_id, sessionHash: session.token_hash },
          input.market,
          () => reserveBrokerRequestBudget(store, session.user_id, production),
        );
        const contract = (() => {
          try {
            return provider.instruments.resolveResearch(
              "kotak",
              input.market,
              input,
            );
          } catch {
            return fail(
              422,
              "Exact contract unavailable in the current master. Expired contracts are not substituted with current tokens.",
            );
          }
        })();
        if (contract.instrument !== input.instrument) {
          fail(
            422,
            "The selected instrument identity changed. Search and select it again.",
          );
        }
        await reserveBrokerRequestBudget(store, session.user_id, production);
        const raw = await provider.getHistoricalCandles(
          session.user_id,
          session.token_hash,
          input,
        );
        if (!provider.isConnected(session.user_id, session.token_hash)) {
          fail(409, "Market-data session changed while loading history.");
        }
        const candles = (() => {
          try {
            return validateHistoricalCandles(input, raw);
          } catch {
            return fail(
              502,
              "The broker returned invalid historical candles. No replacement data was used.",
            );
          }
        })();
        if (!candles.length) {
          fail(
            422,
            "No broker history for this contract and range. Choose another session or check historical coverage.",
          );
        }
        res.json({
          source: provider.id,
          instrument: contract,
          request: input,
          candles,
          fetchedAt: new Date().toISOString(),
          adjustmentPolicy:
            "Provider supplied; corporate-action adjustment not independently verified.",
          coverage:
            "Current-master contracts only. Missing sessions are not filled; historical coverage is provider dependent.",
        });
      });
    },
  );
}
