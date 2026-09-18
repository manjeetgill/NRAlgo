/** Broker-fed paper control plane, mounted after auth/CSRF. Broker capabilities are read-only.
 * Durable ledgers are owner+broker scoped and row-locked. No real execution module is imported.
 * Matching is explicit/polled by the active page, not a background strategy scheduler.
 */
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./database.js";
import type { BrokerManager } from "./brokers.js";
import { KotakDataManager, kotakLoginSchema } from "./kotak-data.js";
import { reserveResearchRequest } from "./research-routes.js";
import { normalizeResearchQuote } from "./strategy-lab.js";
import { fail, rateLimit } from "./security.js";
import {
  InstrumentCatalog,
  instrumentSearchSchema,
} from "./instrument-master.js";
import {
  paperBrokerSchema,
  paperOrderInput,
  newPaperLedger,
  expirePaperOrders,
  placePaperOrder,
  modifyPaperOrder,
  cancelPaperOrder,
  matchPaperOrders,
  paperSummary,
  freshPaperQuote,
  paperInstrumentKey,
  paperOptionSchema,
  paperTradingDay,
  type PaperInput,
  type PaperBroker,
  type PaperLedger,
  type PaperQuote,
} from "./paper-model.js";

export function registerPaperRoutes(
  app: Express,
  store: Store,
  icici: BrokerManager,
  kotak: KotakDataManager,
  production: boolean,
  catalog = new InstrumentCatalog(),
) {
  const limit = rateLimit(30, 60000, (req) => req.res!.locals.session.user_id);
  app.use("/api/paper", (req, res, next) =>
    req.path.endsWith("/cancel") || req.method === "DELETE"
      ? next()
      : limit(req, res, next),
  );
  /** Serialize all local money/order writes on the wallet row; no HTTP call runs under this lock. */
  async function ledger(
    userId: string,
    broker: PaperBroker,
    action: (state: PaperLedger) => void = () => {},
  ) {
    return store.transaction(async (query) => {
      await query(
        "INSERT INTO paper_accounts VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [userId, broker, JSON.stringify(newPaperLedger())],
      );
      const [row] = await query<{ ledger: string }>(
        "SELECT ledger FROM paper_accounts WHERE user_id=$1 AND broker=$2 FOR UPDATE",
        [userId, broker],
      );
      const state = JSON.parse(row.ledger) as PaperLedger;
      expirePaperOrders(state, Date.now());
      try {
        action(state);
      } catch (error) {
        fail(
          409,
          error instanceof Error ? error.message : "Paper operation failed.",
        );
      }
      await query(
        "UPDATE paper_accounts SET ledger=$3 WHERE user_id=$1 AND broker=$2",
        [userId, broker, JSON.stringify(state)],
      );
      return paperSummary(state, Date.now());
    });
  }
  function connected(userId: string, broker: PaperBroker, hash: string) {
    return broker === "kotak"
      ? kotak.connected(userId, hash)
      : Boolean(
          icici.get(userId) &&
          icici.get(userId)!.snapshot().state !== "disconnected",
        );
  }
  /** Login makes two documented authentication calls, never an order request. No raw secrets in responses. */
  app.post("/api/paper/kotak/connect", async (req, res) => {
    const input = kotakLoginSchema.parse(req.body),
      session = res.locals.session;
    await reserveResearchRequest(store, session.user_id, production);
    await reserveResearchRequest(store, session.user_id, production);
    await icici.exclusive(session.user_id, async () => {
      try {
        await kotak.connect(
          session.user_id,
          session.token_hash,
          session.expires * 1000,
          input,
        );
      } catch {
        fail(
          502,
          "Kotak login failed. Verify token, TOTP, MPIN and host. Credentials are not saved.",
        );
      }
    });
    res.json({ connected: true });
  });
  app.delete("/api/paper/kotak/connect", (req, res) => {
    kotak.disconnect(res.locals.session.user_id);
    res.json({ connected: false });
  });
  app.get("/api/paper/:broker", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      session = res.locals.session;
    res.json({
      broker,
      connected: connected(session.user_id, broker, session.token_hash),
      ...(await ledger(session.user_id, broker)),
    });
  });
  /** Search explicit current NSE metadata only; no order or quote fan-out. Never accept a client URL. */
  app.post("/api/paper/:broker/instruments", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      input = instrumentSearchSchema.parse(req.body),
      session = res.locals.session;
    if (!connected(session.user_id, broker, session.token_hash))
      fail(409, "Connect the selected broker before instrument search.");
    await icici.exclusive(session.user_id, async () => {
      if (!catalog.isFresh(broker, input.market)) {
        await reserveResearchRequest(store, session.user_id, production);
        if (broker === "kotak")
          await reserveResearchRequest(store, session.user_id, production);
        try {
          const url =
            broker === "kotak"
              ? await kotak.instrumentMasterUrl(
                  session.user_id,
                  session.token_hash,
                  input.market,
                )
              : undefined;
          await catalog.load(broker, input.market, url);
        } catch {
          fail(
            502,
            "Instrument master unavailable or unsupported. No guessed contracts were substituted.",
          );
        }
      }
      if (!connected(session.user_id, broker, session.token_hash))
        fail(409, "Broker disconnected during instrument search.");
      res.json(catalog.search(broker, input));
    });
  });
  app.post("/api/paper/:broker/orders", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      input = paperOrderInput.parse(req.body),
      session = res.locals.session;
    if (broker === "kotak" && !/^\d{1,15}$/.test(input.instrument))
      fail(422, "Kotak requires an NSE instrument token (pSymbol).");
    if (!connected(session.user_id, broker, session.token_hash))
      fail(409, "Connect the selected data broker first.");
    res.json(
      await ledger(session.user_id, broker, (state) => {
        catalog.validate(broker, input, input.quantity);
        if (
          broker === "kotak" &&
          state.orders.some(
            (o) =>
              o.instrument === input.instrument &&
              Boolean(o.option) === Boolean(input.option) &&
              paperInstrumentKey(o) !== paperInstrumentKey(input),
          )
        )
          throw new Error(
            "This Kotak token is already bound to a different contract.",
          );
        const instruments = new Set([
          ...state.orders
            .filter((o) => o.state === "open")
            .map(paperInstrumentKey),
          ...Object.keys(state.positions).filter(
            (k) => state.positions[k].quantity,
          ),
          paperInstrumentKey(input),
        ]);
        if (instruments.size > 4)
          throw new Error(
            "This paper wallet supports four active instruments.",
          );
        placePaperOrder(state, input, Date.now());
      }),
    );
  });
  app.post("/api/paper/:broker/orders/:key/modify", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      key = z.string().uuid().parse(req.params.key);
    const input = paperOrderInput
      .pick({ quantity: true, limitPaise: true })
      .parse(req.body);
    res.json(
      await ledger(res.locals.session.user_id, broker, (state) => {
        const order = state.orders.find((order) => order.key === key);
        if (order) catalog.validate(broker, order, input.quantity);
        modifyPaperOrder(
          state,
          key,
          input.quantity,
          input.limitPaise,
          Date.now(),
        );
      }),
    );
  });
  app.post("/api/paper/:broker/orders/:key/cancel", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      key = z.string().uuid().parse(req.params.key);
    res.json(
      await ledger(res.locals.session.user_id, broker, (state) =>
        cancelPaperOrder(state, key, Date.now()),
      ),
    );
  });
  /** Fetch each tracked instrument once per explicit cycle. Failure never substitutes synthetic prices. */
  app.post("/api/paper/:broker/refresh", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      session = res.locals.session;
    const input = z
      .object({
        instrument: paperOrderInput.shape.instrument.optional(),
        option: paperOptionSchema.optional(),
        masterToken: paperOrderInput.shape.masterToken,
      })
      .strict()
      .refine(
        (value) =>
          (!value.option && !value.masterToken) || Boolean(value.instrument),
        "An option needs an instrument.",
      )
      .parse(req.body);
    const before = await ledger(session.user_id, broker);
    const contracts = new Map<
      string,
      Pick<PaperInput, "instrument" | "option" | "masterToken">
    >();
    for (const order of before.orders)
      if (
        order.state === "open" ||
        before.positions[paperInstrumentKey(order)]?.quantity
      )
        contracts.set(paperInstrumentKey(order), order);
    if (input.instrument)
      contracts.set(
        paperInstrumentKey({
          instrument: input.instrument,
          option: input.option,
        }),
        {
          instrument: input.instrument,
          option: input.option,
          masterToken: input.masterToken,
        },
      );
    if (contracts.size > 4)
      fail(422, "Refresh supports at most four active instruments.");
    if (!connected(session.user_id, broker, session.token_hash))
      fail(409, "Selected broker disconnected. Paper matching is paused.");
    const quotes: PaperQuote[] = [];
    await icici.exclusive(session.user_id, async () => {
      // A manual draft must not bypass validation of a previously master-selected held contract.
      for (const order of before.orders) {
        if (
          (order.state === "open" ||
            before.positions[paperInstrumentKey(order)]?.quantity) &&
          (!order.option ||
            order.option.expiryDate >= paperTradingDay(Date.now()))
        )
          try {
            catalog.validate(broker, order);
          } catch {
            fail(
              409,
              "Reload instrument search before matching master-selected contracts.",
            );
          }
      }
      for (const [key, contract] of contracts) {
        const { instrument, option } = contract;
        if (option && option.expiryDate < paperTradingDay(Date.now())) continue;
        try {
          catalog.validate(broker, contract);
        } catch {
          fail(
            409,
            "Selected instrument master expired or changed. Reload instrument search before matching.",
          );
        }
        await reserveResearchRequest(store, session.user_id, production);
        try {
          if (broker === "kotak")
            quotes.push({
              ...(await kotak.quote(
                session.user_id,
                session.token_hash,
                instrument,
                option ? "nse_fo" : "nse_cm",
              )),
              instrument: key,
            });
          else {
            const raw = await icici.get(session.user_id)!.call("quotes", {
              stockCode: instrument,
              exchangeCode: option ? "NFO" : "NSE",
              productType: option ? "options" : "cash",
              ...(option
                ? {
                    expiryDate: `${option.expiryDate}T00:00:00.000Z`,
                    right: option.right,
                    strikePrice: String(option.strikePrice),
                  }
                : {}),
            });
            const quote = normalizeResearchQuote(
              raw,
              { market: option ? "options" : "cash" },
              {
                stockCode: instrument,
                side: "buy",
                quantity: 1,
                ...(option
                  ? {
                      expiryDate: option.expiryDate,
                      right: option.right,
                      strikePrice: option.strikePrice,
                    }
                  : {}),
              },
            );
            quotes.push({
              instrument: key,
              bid: Math.round(quote.bid * 100),
              ask: Math.round(quote.ask * 100),
              observedAt: quote.observedAt || 0,
              receivedAt: Date.now(),
            });
          }
        } catch {
          fail(
            502,
            "Broker quote unavailable. No orders matched in this refresh. Verify connection and instrument.",
          );
        }
      }
    });
    const state = await ledger(session.user_id, broker, (value) =>
      matchPaperOrders(value, quotes, Date.now()),
    );
    res.json({
      ...state,
      quotes,
      stale: quotes.some((quote) => !freshPaperQuote(quote, Date.now())),
    });
  });
  /** Owner-scoped account reads never create or modify a paper wallet or submit orders. */
  app.post("/api/portfolio/:broker/refresh", limit, async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      session = res.locals.session;
    if (!connected(session.user_id, broker, session.token_hash))
      fail(409, "Connect the selected broker first.");
    const result: Record<string, unknown> = {
      broker,
      readOnly: true,
      observedAt: Date.now(),
    };
    await icici.exclusive(session.user_id, async () => {
      for (const kind of ["positions", "holdings"] as const) {
        await reserveResearchRequest(store, session.user_id, production);
        try {
          const rows =
            broker === "kotak"
              ? await kotak.portfolio(session.user_id, session.token_hash, kind)
              : await icici.get(session.user_id)!.call(kind);
          result[kind] = { rows, error: null };
        } catch {
          result[kind] = {
            rows: null,
            error: `${kind} unavailable. Verify your broker session; this is not an empty portfolio.`,
          };
        }
      }
    });
    res.json(result);
  });
}
