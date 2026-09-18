/** Owner-scoped strategy lab endpoints. The only injected broker capability is read-only data.
 * Save/build/replay/quote can never dispatch orders; cash drafts leave this module for the
 * separately authenticated live UI. Broker data is fetched server-side, not supplied by clients.
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Store, lockWorkspaceSettings, audit, now } from "./database.js";
import { BrokerManager } from "./brokers.js";
import { fail, rateLimit } from "./security.js";
import {
  researchStrategySchema,
  normalizeHistoricalCandles,
  simulateHistoricalBasket,
  marketDataParameters,
  normalizeResearchQuote,
  normalizeOptionChain,
  type ResearchStrategy,
} from "./strategy-lab.js";

/** Reserve shared daily/minute budget before each RPC, leaving live cancellation headroom.
 * A short option basket consumes one request per leg; no implicit refresh loops or retries.
 */
async function reserveResearchRequest(
  store: Store,
  userId: string,
  requireMfa: boolean,
) {
  await store.transaction(async (query) => {
    await lockWorkspaceSettings(query, store, userId);
    if (requireMfa) {
      const [row] = await query<{ enabled: boolean }>(
        "SELECT enabled FROM user_security WHERE user_id=$1",
        [userId],
      );
      if (!row?.enabled)
        fail(403, "Enable MFA before requesting broker data on this server.");
    }
    const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10),
      minute = Math.floor(Date.now() / 60000) * 60000;
    const [daily] = await query<{ usage_day: string; request_count: number }>(
      "SELECT * FROM broker_usage WHERE user_id=$1",
      [userId],
    );
    const [window] = await query<{
      window_start: number;
      request_count: number;
    }>("SELECT * FROM broker_rpc_windows WHERE user_id=$1", [userId]);
    const count = daily?.usage_day === day ? daily.request_count : 0,
      perMinute = window?.window_start === minute ? window.request_count : 0;
    if (count >= 4000 || perMinute >= 60)
      fail(429, "Market-data budget reached. Wait before refreshing.");
    await query(
      "INSERT INTO broker_usage VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET usage_day=$2,request_count=$3",
      [userId, day, count + 1],
    );
    await query(
      "INSERT INTO broker_rpc_windows VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET window_start=$2,request_count=$3",
      [userId, minute, perMinute + 1],
    );
  });
}
/** Register after global authentication/CSRF middleware. All IDs are resolved with user_id. */
export function registerResearchRoutes(
  app: Express,
  store: Store,
  manager: BrokerManager,
  requireMfa: boolean,
) {
  const researchLimit = rateLimit(
    30,
    60000,
    (req) => req.res!.locals.session.user_id,
  );
  app.use("/api/research", (req, res, next) =>
    req.path === "/stream/stop" ? next() : researchLimit(req, res, next),
  );
  const identity = z.string().uuid();
  async function loadStrategy(
    userId: string,
    id: string,
  ): Promise<ResearchStrategy> {
    const [row] = await store.transaction((query) =>
      query<{ definition: string }>(
        "SELECT definition FROM research_strategies WHERE id=$1 AND user_id=$2",
        [identity.parse(id), userId],
      ),
    );
    if (!row) fail(404, "Research strategy not found.");
    return researchStrategySchema.parse(JSON.parse(row.definition));
  }
  /** Exact-expiry chains are fetched on demand; two metered calls, never an unbounded scanner. */
  app.post("/api/research/option-chain", async (req, res) => {
    const input = z
      .object({
        stockCode: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9 &_.-]{1,30}$/),
        expiryDate: z.iso.date(),
      })
      .strict()
      .parse(req.body);
    const userId = res.locals.session.user_id;
    await manager.exclusive(userId, async () => {
      const connection =
        manager.get(userId) ||
        fail(409, "Connect or reconnect ICICI under Brokers first.");
      const contracts = [];
      for (const right of ["call", "put"] as const) {
        await reserveResearchRequest(store, userId, requireMfa);
        let raw;
        try {
          raw = await connection.call("optionChain", {
            stockCode: input.stockCode,
            exchangeCode: "NFO",
            productType: "options",
            expiryDate: `${input.expiryDate}T00:00:00.000Z`,
            right,
          });
        } catch {
          return fail(
            502,
            "Option chain unavailable. Verify underlying, expiry and ICICI session.",
          );
        }
        try {
          contracts.push(
            ...normalizeOptionChain(
              raw,
              input.stockCode,
              input.expiryDate,
              right,
            ),
          );
        } catch (error) {
          return fail(422, (error as Error).message);
        }
      }
      res.json({
        source: "icici-breeze",
        contracts,
        receivedAt: Date.now(),
        complete: false,
      });
    });
  });
  /** Start a server-resolved basket on the existing data-only worker, not the live OMS. */
  app.post("/api/research/stream", async (req, res) => {
    const input = z.object({ strategyId: identity }).strict().parse(req.body),
      userId = res.locals.session.user_id;
    const strategy = await loadStrategy(userId, input.strategyId);
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    if (strategy.legs.some((leg) => leg.expiryDate && leg.expiryDate < today))
      fail(
        422,
        "Expired contracts cannot start a live feed. Use historical replay instead.",
      );
    await manager.exclusive(userId, async () => {
      const connection =
        manager.get(userId) ||
        fail(409, "Connect or reconnect ICICI under Brokers first.");
      if (!connection.researchSnapshot)
        fail(503, "Basket streaming is unavailable on this connection.");
      await reserveResearchRequest(store, userId, requireMfa);
      const streamId = randomUUID();
      const legs = strategy.legs.map((leg) => {
        const params = marketDataParameters(strategy, leg);
        if (leg.expiryDate) {
          const date = new Date(`${leg.expiryDate}T00:00:00Z`);
          params.expiryDate = `${String(date.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]}-${date.getUTCFullYear()}`;
        }
        return params;
      });
      try {
        await connection.call("subscribeBasket", {
          streamId,
          strategyId: input.strategyId,
          legs,
        });
      } catch {
        return fail(
          502,
          "Basket feed could not start. Verify every contract exists in the current instrument master.",
        );
      }
      res.json({
        streamId,
        strategyId: input.strategyId,
        state: "waiting",
        expiresWithoutHeartbeatMs: 45000,
      });
    });
  });
  /** Browser polling reads a bounded local cache; it does not issue broker REST requests.
   * Both opaque IDs and owner lookup prevent another account/tab's cache being misattributed.
   */
  app.get("/api/research/stream", async (req, res) => {
    const input = z
        .object({ strategyId: identity, streamId: identity })
        .strict()
        .parse(req.query),
      userId = res.locals.session.user_id;
    await loadStrategy(userId, input.strategyId);
    const current = manager.get(userId)?.researchSnapshot?.(input.streamId);
    if (!current || current.strategyId !== input.strategyId)
      fail(409, "Stream ended or was replaced. Start streaming again.");
    res.json(current);
  });
  /** Idempotent stop targets one generation so a closing old tab cannot stop a newer stream. */
  app.post("/api/research/stream/stop", async (req, res) => {
    const input = z.object({ streamId: identity }).strict().parse(req.body),
      userId = res.locals.session.user_id;
    await manager.exclusive(userId, async () => {
      const connection = manager.get(userId);
      if (connection)
        try {
          await connection.call("stopBasket", input);
        } catch {
          return fail(
            502,
            "Stop acknowledgement unavailable; the feed lease expires without heartbeats.",
          );
        }
    });
    res.json({ stopped: true });
  });
  app.get("/api/research", async (_req, res) => {
    const userId = res.locals.session.user_id;
    const result = await store.transaction(async (query) => ({
      strategies: (
        await query<{ id: string; definition: string; created_at: string }>(
          "SELECT id,definition,created_at FROM research_strategies WHERE user_id=$1 ORDER BY created_at DESC",
          [userId],
        )
      ).map((row) => ({
        id: row.id,
        definition: JSON.parse(row.definition),
        createdAt: row.created_at,
      })),
      runs: await query(
        "SELECT id,strategy_id,created_at FROM research_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",
        [userId],
      ),
    }));
    res.json(result);
  });
  app.post("/api/research/strategies", async (req, res) => {
    const strategy = researchStrategySchema.parse(req.body),
      userId = res.locals.session.user_id,
      id = randomUUID();
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      const [row] = await query<{ count: string }>(
        "SELECT COUNT(*) FROM research_strategies WHERE user_id=$1",
        [userId],
      );
      if (Number(row.count) >= 50)
        fail(
          409,
          "Research library is full (50). Remove a saved strategy first.",
        );
      await query("INSERT INTO research_strategies VALUES($1,$2,$3,$4)", [
        id,
        userId,
        JSON.stringify(strategy),
        now(),
      ]);
      await audit(
        query,
        "Saved a research strategy (no execution enabled).",
        userId,
      );
    });
    res.status(201).json({ id, definition: strategy });
  });
  app.delete("/api/research/strategies/:id", async (req, res) => {
    const userId = res.locals.session.user_id,
      id = identity.parse(req.params.id);
    const rows = await store.transaction((query) =>
      query(
        "DELETE FROM research_strategies WHERE id=$1 AND user_id=$2 RETURNING id",
        [id, userId],
      ),
    );
    if (!rows.length) fail(404, "Research strategy not found.");
    res.json({ ok: true });
  });
  app.get("/api/research/runs/:id", async (req, res) => {
    const [row] = await store.transaction((query) =>
      query<{ result: string }>(
        "SELECT result FROM research_runs WHERE id=$1 AND user_id=$2",
        [identity.parse(req.params.id), res.locals.session.user_id],
      ),
    );
    if (!row) fail(404, "Research run not found.");
    res.json(JSON.parse(row.result));
  });
  app.post("/api/research/backtest", async (req, res) => {
    const input = z
      .object({
        strategyId: identity,
        day: z.iso.date(),
        interval: z.enum(["1minute", "5minute"]),
      })
      .strict()
      .parse(req.body);
    const userId = res.locals.session.user_id,
      strategy = await loadStrategy(userId, input.strategyId);
    if (Date.parse(`${input.day}T15:30:00+05:30`) > Date.now())
      fail(422, "Choose a completed historical trading session.");
    if (
      strategy.legs.some((leg) => leg.expiryDate && leg.expiryDate < input.day)
    )
      fail(422, "Selected session is after a contract expiry.");
    await manager.exclusive(userId, async () => {
      const connection =
        manager.get(userId) ||
        fail(409, "Connect or reconnect ICICI under Brokers first.");
      const histories = [];
      for (const leg of strategy.legs) {
        await reserveResearchRequest(store, userId, requireMfa);
        let raw: unknown;
        try {
          raw = await connection.call("historical", {
            ...marketDataParameters(strategy, leg),
            interval: input.interval,
            // Historical-v2's documented query uses exchange-local wall time, unlike
            // signing timestamps. Do not shift this session window to 03:45 UTC.
            fromDate: `${input.day} 09:15:00`,
            toDate: `${input.day} 15:29:59`,
          });
        } catch {
          return fail(
            502,
            "ICICI history unavailable. Check the contract, session and historical coverage; no synthetic replacement was used.",
          );
        }
        try {
          histories.push(
            normalizeHistoricalCandles(
              raw,
              input.day,
              input.interval === "1minute" ? 1 : 5,
            ),
          );
        } catch (error) {
          return fail(422, (error as Error).message);
        }
      }
      let result;
      try {
        result = simulateHistoricalBasket(strategy, histories, input.day);
      } catch (error) {
        return fail(422, (error as Error).message);
      }
      const id = randomUUID();
      await store.transaction(async (query) => {
        await lockWorkspaceSettings(query, store, userId);
        // A deleted template cannot leave an orphan result, even if the data fetch was in flight.
        const owner = await query(
          "SELECT id FROM research_strategies WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [input.strategyId, userId],
        );
        if (!owner.length)
          fail(409, "Strategy was removed during the request.");
        await query("INSERT INTO research_runs VALUES($1,$2,$3,$4,$5)", [
          id,
          userId,
          input.strategyId,
          JSON.stringify(result),
          now(),
        ]);
        await query(
          "DELETE FROM research_runs WHERE user_id=$1 AND id NOT IN (SELECT id FROM research_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30)",
          [userId],
        );
      });
      res.json({ id, ...result });
    });
  });
  app.post("/api/research/quotes", async (req, res) => {
    const input = z.object({ strategyId: identity }).strict().parse(req.body),
      userId = res.locals.session.user_id;
    const strategy = await loadStrategy(userId, input.strategyId);
    await manager.exclusive(userId, async () => {
      const connection =
        manager.get(userId) ||
        fail(409, "Connect or reconnect ICICI under Brokers first.");
      const quotes = [];
      for (const leg of strategy.legs) {
        await reserveResearchRequest(store, userId, requireMfa);
        let raw;
        try {
          raw = await connection.call(
            "quotes",
            marketDataParameters(strategy, leg),
          );
        } catch {
          return fail(
            502,
            "ICICI quote request failed. Check contract/session and reconnect if needed.",
          );
        }
        try {
          quotes.push(normalizeResearchQuote(raw, strategy, leg));
        } catch (error) {
          return fail(422, (error as Error).message);
        }
      }
      // Quotes are sequential snapshots, not an atomic exchange basket or executable spread.
      res.json({
        source: "icici-breeze",
        quotes,
        receivedAt: Date.now(),
        optionsExecutionEnabled: false,
      });
    });
  });
}
