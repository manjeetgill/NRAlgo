/** HTTP endpoints for the Kotak Market data screen. Login and CSRF are checked in main.ts.
 * All network reads share the research budget/MFA gate. Stream cache polling is local only.
 */
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./database.js";
import type { BrokerRequestCoordinator } from "./broker-data-access.js";
import type { KotakMarketDataClient } from "./kotak-market-data-client.js";
import { marketRequestSchema } from "./kotak-market-data-contracts.js";
import { feedRequestSchema } from "./kotak-market-data-stream.js";
import { reserveBrokerRequestBudget } from "./strategy-research-routes.js";
import { fail, rateLimit } from "./security.js";

/** Explicit operations prevent this router becoming a generic broker proxy. */
export function registerKotakMarketDataRoutes(
  app: Express,
  store: Store,
  requestCoordinator: BrokerRequestCoordinator,
  kotak: KotakMarketDataClient,
  production: boolean,
) {
  const limit = rateLimit(30, 60000, (req) => req.res!.locals.session.user_id);
  // Validate first, reserve the shared request budget, then fetch from the user's broker session.
  app.post("/api/market/kotak/read", limit, async (req, res) => {
    const input = marketRequestSchema.safeParse(req.body);
    if (!input.success) {
      return fail(
        422,
        "Invalid market query. Use unique tokens, supported segments/filters and an ordered history range within the interval limit.",
      );
    }
    const session = res.locals.session;
    await requestCoordinator.runExclusiveForUser(session.user_id, async () => {
      await reserveBrokerRequestBudget(store, session.user_id, production);
      res.json(
        await kotak.fetchMarketData(
          session.user_id,
          session.token_hash,
          input.data,
        ),
      );
    });
  });
  app.post("/api/market/kotak/feed", limit, async (req, res) => {
    const input = feedRequestSchema.parse(req.body);
    const session = res.locals.session;
    await requestCoordinator.runExclusiveForUser(session.user_id, async () => {
      // One authentication frame plus one subscription/snapshot; reconnect is never automatic.
      await reserveBrokerRequestBudget(store, session.user_id, production);
      await reserveBrokerRequestBudget(store, session.user_id, production);
      res.json(
        kotak.startMarketDataStream(session.user_id, session.token_hash, input),
      );
    });
  });
  // Cache reads cost no broker request; they also tell the stream that its viewer is still active.
  app.get("/api/market/kotak/feed", (req, res) => {
    const session = res.locals.session;
    res.json(
      kotak.getMarketDataStreamSnapshot(session.user_id, session.token_hash),
    );
  });
  app.post("/api/market/kotak/feed/control", limit, async (req, res) => {
    const { action } = z
      .object({ action: z.enum(["subscribe", "unsubscribe", "snapshot"]) })
      .strict()
      .parse(req.body);
    const session = res.locals.session;
    await requestCoordinator.runExclusiveForUser(session.user_id, async () => {
      await reserveBrokerRequestBudget(store, session.user_id, production);
      res.json(
        kotak.sendMarketDataStreamCommand(
          session.user_id,
          session.token_hash,
          action,
        ),
      );
    });
  });
  // Stopping is local and must remain available even after the broker request budget runs out.
  app.delete("/api/market/kotak/feed", (req, res) => {
    const session = res.locals.session;
    kotak.stopMarketDataStream(session.user_id, session.token_hash);
    res.json({ state: "stopped", records: [], notifications: [] });
  });
}
