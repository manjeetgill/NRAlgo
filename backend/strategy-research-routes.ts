/** HTTP endpoints for saving strategies, replaying stored daily candles and previewing quotes.
 * Save/build/replay/quote can never dispatch orders. Stored simulation is broker-independent;
 * explicit quote previews remain behind the market-data provider boundary.
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Store, lockWorkspaceSettings, audit, now } from "./database.js";
import { BrokerRequestCoordinator } from "./broker-data-access.js";
import type { MarketDataProvider } from "./market-data-provider.js";
import { fail, rateLimit } from "./security.js";
import {
  researchStrategySchema,
  type ResearchStrategy,
} from "./research-contracts.js";
import { readStoredDailyCandle } from "./eod-market-data.js";
import { CalculationClient } from "./calculation-client.js";

/** Count one broker request before sending it. The database lock prevents two concurrent
 * routes from spending the same remaining allowance. Production callers also need MFA.
 */
export async function reserveBrokerRequestBudget(
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
      if (!row?.enabled) {
        fail(403, "Enable MFA before requesting broker data on this server.");
      }
    }
    const indiaTimezoneOffsetMs = 5.5 * 60 * 60 * 1000;
    const day = new Date(Date.now() + indiaTimezoneOffsetMs)
      .toISOString()
      .slice(0, 10);
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const [daily] = await query<{ usage_day: string; request_count: number }>(
      "SELECT * FROM broker_usage WHERE user_id=$1",
      [userId],
    );
    const [window] = await query<{
      window_start: number;
      request_count: number;
    }>("SELECT * FROM broker_rpc_windows WHERE user_id=$1", [userId]);
    const count = daily?.usage_day === day ? daily.request_count : 0;
    const perMinute =
      window?.window_start === minute ? window.request_count : 0;
    if (count >= 4000 || perMinute >= 60) {
      fail(429, "Market-data budget reached. Wait before refreshing.");
    }
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
  requestCoordinator: BrokerRequestCoordinator,
  requireMfa: boolean,
  brokerDataReader: MarketDataProvider,
  calculationClient: Pick<CalculationClient, "storedDaily">,
) {
  const catalog = brokerDataReader.instruments;
  const researchLimit = rateLimit(
    30,
    60000,
    (req) => req.res!.locals.session.user_id,
  );
  app.use("/api/research", (req, res, next) =>
    req.path === "/stream/stop" ? next() : researchLimit(req, res, next),
  );
  const identity = z.string().uuid();
  /** Resolve each contract from the saved definition; never substitute another data source. */
  async function resolveStrategyContracts(
    strategy: ResearchStrategy,
    session: { user_id: string; token_hash: string },
  ) {
    if (!brokerDataReader.isConnected(session.user_id, session.token_hash)) {
      fail(409, "Connect the selected market-data provider first.");
    }
    if (!catalog.isFresh(strategy.market)) {
      try {
        await brokerDataReader.prepareInstruments(
          { userId: session.user_id, sessionHash: session.token_hash },
          strategy.market,
          () => reserveBrokerRequestBudget(store, session.user_id, requireMfa),
        );
      } catch {
        fail(
          502,
          "Provider instrument master unavailable. No alternative data was substituted.",
        );
      }
    }
    try {
      return strategy.legs.map((leg) => catalog.resolve(strategy.market, leg));
    } catch {
      return fail(
        422,
        "Exact provider contract not found. Select a listed contract; expired contracts are not mapped to current tokens.",
      );
    }
  }
  /** Look up the definition using both strategy ID and signed-in user ID. Never let a
   * caller load another user's strategy simply by knowing its UUID.
   */
  async function loadUserResearchStrategy(
    userId: string,
    id: string,
  ): Promise<ResearchStrategy> {
    const [row] = await store.transaction((query) =>
      query<{ definition: string }>(
        "SELECT definition FROM research_strategies WHERE id=$1 AND user_id=$2",
        [identity.parse(id), userId],
      ),
    );
    if (!row) {
      fail(404, "Research strategy not found.");
    }
    const definition = JSON.parse(row.definition);
    if (definition.broker !== "kotak") {
      fail(409, "Unsupported legacy strategy. Create a new Kotak strategy.");
    }
    return researchStrategySchema.parse(definition);
  }
  /** Persist one owner-scoped research result only while its saved definition still exists. */
  async function saveResearchRun(
    userId: string,
    strategyId: string,
    result: unknown,
  ) {
    const id = randomUUID();
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      const owner = await query(
        "SELECT id FROM research_strategies WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [strategyId, userId],
      );
      if (!owner.length) {
        fail(409, "Strategy was removed during the request.");
      }
      await query("INSERT INTO research_runs VALUES($1,$2,$3,$4,$5)", [
        id,
        userId,
        strategyId,
        JSON.stringify(result),
        now(),
      ]);
      await query(
        "DELETE FROM research_runs WHERE user_id=$1 AND id NOT IN (SELECT id FROM research_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30)",
        [userId],
      );
    });
    return id;
  }
  /** Reduce a validated saved cash strategy to the broker-free Python contract. */
  function storedDailyStrategy(strategy: ResearchStrategy) {
    return {
      schemaVersion: strategy.schemaVersion,
      name: strategy.name,
      quantity: strategy.legs[0].quantity,
      capital: strategy.capital,
      marginReserve: strategy.marginReserve,
      stopLoss: strategy.stopLoss,
      targetProfit: strategy.targetProfit,
      slippageBps: strategy.slippageBps,
      feePerOrder: strategy.feePerOrder,
    };
  }
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
    if (strategy.market === "cash" && !strategy.legs[0].dataInstrumentId) {
      fail(422, "Select the cash/index scrip from the stored catalog first.");
    }
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      const [row] = await query<{ count: string }>(
        "SELECT COUNT(*) FROM research_strategies WHERE user_id=$1",
        [userId],
      );
      if (Number(row.count) >= 50) {
        fail(
          409,
          "Research library is full (50). Remove a saved strategy first.",
        );
      }
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
    if (!rows.length) {
      fail(404, "Research strategy not found.");
    }
    res.json({ ok: true });
  });
  app.get("/api/research/runs/:id", async (req, res) => {
    const [row] = await store.transaction((query) =>
      query<{ result: string }>(
        "SELECT result FROM research_runs WHERE id=$1 AND user_id=$2",
        [identity.parse(req.params.id), res.locals.session.user_id],
      ),
    );
    if (!row) {
      fail(404, "Research run not found.");
    }
    res.json(JSON.parse(row.result));
  });
  app.post("/api/research/backtest", async (req, res) => {
    const input = z
      .object({
        strategyId: identity,
        day: z.iso.date(),
        interval: z.literal("day"),
      })
      .strict()
      .parse(req.body);
    const userId = res.locals.session.user_id,
      strategy = await loadUserResearchStrategy(userId, input.strategyId);
    if (Date.parse(`${input.day}T15:30:00+05:30`) > Date.now()) {
      fail(422, "Choose a completed historical trading session.");
    }
    if (strategy.market !== "cash") {
      fail(
        422,
        "Stored historical data contains daily cash/index candles, not historical option premiums.",
      );
    }
    const leg = strategy.legs[0],
      dataInstrumentId = leg.dataInstrumentId;
    if (!dataInstrumentId) {
      fail(422, "Reselect this strategy from the stored instrument catalog.");
    }
    const candle = await readStoredDailyCandle(
      store,
      dataInstrumentId!,
      leg.stockCode,
      input.day,
    );
    if (!candle) {
      fail(422, "No stored daily candle exists for this scrip and session.");
    }
    let calculation;
    try {
      calculation = await calculationClient.storedDaily(
        storedDailyStrategy(strategy),
        [
          {
            date: candle.day,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          },
        ],
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      return fail(status === 503 ? 503 : 422, (error as Error).message);
    }
    const result = {
      ...calculation.sessions[0],
      strategy,
      dataSource: "stored-eod",
      engineVersion: calculation.engineVersion,
    };
    const id = await saveResearchRun(userId, input.strategyId, result);
    res.json({ id, ...result });
  });
  /** Independent stored daily replays. Each requested date is accounted for and missing
   * sessions are skipped; no broker quota, session or network call is involved.
   */
  app.post("/api/research/backtest/batch", async (req, res) => {
    const input = z
      .object({
        strategyId: identity,
        interval: z.literal("day"),
        days: z.array(z.iso.date()).min(1).max(20),
      })
      .strict()
      .parse(req.body);
    const days = [...new Set(input.days)].sort();
    if (days.length !== input.days.length) {
      fail(422, "Duplicate dates in batch request.");
    }
    const userId = res.locals.session.user_id,
      strategy = await loadUserResearchStrategy(userId, input.strategyId);
    for (const day of days) {
      if (Date.parse(`${day}T15:30:00+05:30`) > Date.now()) {
        fail(422, `${day} is not a completed historical trading session.`);
      }
    }
    if (strategy.market !== "cash") {
      fail(
        422,
        "Stored historical data contains daily cash/index candles, not historical option premiums.",
      );
    }
    const leg = strategy.legs[0],
      dataInstrumentId = leg.dataInstrumentId;
    if (!dataInstrumentId) {
      fail(422, "Reselect this strategy from the stored instrument catalog.");
    }
    const candles: {
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
    }[] = [];
    const skipped: { day: string; reason: string }[] = [];
    for (const day of days) {
      const candle = await readStoredDailyCandle(
        store,
        dataInstrumentId!,
        leg.stockCode,
        day,
      );
      if (!candle) {
        skipped.push({ day, reason: "No stored daily candle." });
        continue;
      }
      candles.push({
        date: candle.day,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    }
    if (!candles.length) {
      fail(
        422,
        `No requested stored session could be completed. First issue: ${skipped[0]?.reason || "unknown"}`,
      );
    }
    let calculation;
    try {
      calculation = await calculationClient.storedDaily(
        storedDailyStrategy(strategy),
        candles,
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      return fail(status === 503 ? 503 : 422, (error as Error).message);
    }
    skipped.push(...calculation.rejected);
    const completed = calculation.sessions.map((session) => ({
      ...session,
      strategy,
    }));
    const result = {
      dataSource: "stored-eod",
      mode: "batch" as const,
      interval: "day" as const,
      requestedDays: days,
      summary: calculation.summary,
      skipped,
      sessions: completed,
      stoppedReason: null,
      engineVersion: calculation.engineVersion,
    };
    const id = await saveResearchRun(userId, input.strategyId, result);
    res.json({ id, ...result });
  });
  app.post("/api/research/quotes", async (req, res) => {
    const input = z.object({ strategyId: identity }).strict().parse(req.body),
      userId = res.locals.session.user_id;
    const strategy = await loadUserResearchStrategy(userId, input.strategyId);
    await requestCoordinator.runExclusiveForUser(userId, async () => {
      if (strategy.broker === "kotak") {
        const contracts = await resolveStrategyContracts(
          strategy,
          res.locals.session,
        );
        await reserveBrokerRequestBudget(store, userId, requireMfa);
        try {
          const snapshots = await brokerDataReader.getQuoteSnapshots(
            userId,
            res.locals.session.token_hash,
            contracts.map((item) => item.instrument),
            strategy.market === "cash" ? "nse_cm" : "nse_fo",
          );
          if (
            snapshots.some(
              (row) =>
                row.price === null || row.bid === null || row.ask === null,
            )
          ) {
            return fail(
              502,
              "Kotak returned incomplete quotes; no placeholder prices were used.",
            );
          }
          res.json({
            source: "kotak",
            quotes: snapshots.map((row, index) => ({
              ...row,
              stockCode: strategy.legs[index].stockCode,
              receivedAt: Date.now(),
            })),
            receivedAt: Date.now(),
            optionsExecutionEnabled: false,
          });
          return;
        } catch {
          return fail(
            502,
            "Kotak quote request failed or returned incomplete data. No alternative data was substituted.",
          );
        }
      }
    });
  });
}
