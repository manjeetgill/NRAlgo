/** HTTP endpoints for simulated orders, virtual balances and broker-provided quotes.
 * Durable ledgers are owner+broker scoped and row-locked. No real execution module is imported.
 * Matching is explicit/polled by the active page, not a background strategy scheduler.
 */
import type { Express } from "express";
import { optionChainSessionOpen } from "./option-chain-session.js";
import { z } from "zod";
import type { Store } from "./database.js";
import type { BrokerRequestCoordinator } from "./broker-data-access.js";
import type { MarketDataProvider } from "./market-data-provider.js";
import {
  KotakConnectionError,
  KotakMarketDataClient,
  kotakLoginSchema,
} from "./kotak-market-data-client.js";
import { reserveBrokerRequestBudget } from "./strategy-research-routes.js";
import { fail, rateLimit } from "./security.js";
import { instrumentSearchSchema } from "./instrument-master.js";
import {
  recordBrokerConnected,
  recordBrokerDisconnected,
  resolveActiveBroker,
} from "./broker-registry.js";
import {
  readOptionChainSnapshot,
  saveOptionChainSnapshot,
  searchStoredOptionUnderlyings,
} from "./option-chain-snapshots.js";
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
  paperMarketOpen,
  paperTradingDay,
  type PaperInput,
  type PaperBroker,
  type PaperLedger,
  type PaperQuote,
} from "./paper-trading-ledger.js";

/** Register the paper wallet and broker-read endpoints after main.ts has checked login/CSRF.
 * Cancelling a simulated order stays available when read-request throttling is reached.
 */
export function registerPaperRoutes(
  app: Express,
  store: Store,
  requestCoordinator: BrokerRequestCoordinator,
  kotak: Pick<
    KotakMarketDataClient,
    | "connect"
    | "disconnect"
    | "isConnected"
    | "getPortfolioRows"
    | "getAccountReport"
    | "executionSession"
  >,
  production: boolean,
  marketData: MarketDataProvider,
) {
  const catalog = marketData.instruments;
  const limit = rateLimit(30, 60000, (req) => req.res!.locals.session.user_id);
  app.use(
    [
      "/api/market/instruments",
      "/api/market/option-chain",
      "/api/market/live-feed",
      "/api/brokers/kotak/connect",
      "/api/brokers/kotak/overview",
    ],
    limit,
  );
  /** Keep the broker position book separate from marks. A manual refresh reuses these
   * open contracts and reads only their latest prices; reconnecting clears the snapshot. */
  const openPositionCache = new Map<
    string,
    {
      sessionHash: string;
      expiresAt: number;
      rows: Awaited<ReturnType<KotakMarketDataClient["getPortfolioRows"]>>;
    }
  >();
  const workspaceExperienceSchema = z.enum(["simulator", "builder", "chain"]);
  // Simulator instruments are index derivatives only; builder retains stock support.
  const simulatorIndexes = new Set([
    "NIFTY",
    "BANKNIFTY",
    "FINNIFTY",
    "MIDCPNIFTY",
    "NIFTYNXT50",
    "SENSEX",
    "BANKEX",
  ]);

  /** Select the data plane once at the API boundary. Simulator never reaches a
   * broker; builder reaches only the owner-selected active provider during NSE
   * weekday hours and otherwise reads durable snapshots.
   */
  async function resolveWorkspaceDataMode(
    experience: z.infer<typeof workspaceExperienceSchema> | undefined,
    session: { user_id: string; token_hash: string },
  ) {
    if (!experience) {
      return "live" as const;
    }
    if (
      experience === "simulator" ||
      !(experience === "chain"
        ? optionChainSessionOpen(Date.now())
        : paperMarketOpen(Date.now()))
    ) {
      return "historical" as const;
    }
    const active = await store.transaction((query) =>
      resolveActiveBroker(query, session.user_id),
    );
    if (active.provider !== marketData.id) {
      fail(
        409,
        `The active broker (${active.provider}) has no configured market-data adapter.`,
      );
    }
    if (!marketData.isConnected(session.user_id, session.token_hash)) {
      fail(409, "Reconnect the active broker before loading live market data.");
    }
    return "live" as const;
  }
  app.use("/api/paper", (req, res, next) =>
    req.path.endsWith("/cancel") || req.method === "DELETE"
      ? next()
      : limit(req, res, next),
  );
  /** Load and lock this user's virtual wallet, apply one local change, then save a summary.
   * The callback must never make a network call: holding a database lock while waiting for
   * a broker could block every later wallet request. Errors roll back the transaction.
   */
  async function withPaperAccountLedger(
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
  /** Only the browser session that logged into Kotak may use its cached broker credentials. */
  function isPaperDataBrokerConnected(
    userId: string,
    broker: PaperBroker,
    sessionHash: string,
  ) {
    return broker === "kotak" && marketData.isConnected(userId, sessionHash);
  }
  /** Login makes two documented authentication calls, never an order request. No raw secrets in responses. */
  app.post(
    ["/api/paper/kotak/connect", "/api/brokers/kotak/connect"],
    async (req, res) => {
      const parsed = kotakLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        // Only static field hints leave the server; never serialize validation inputs.
        const hints: Record<string, string> = {
          accessToken: "API dashboard token is required (8–4096 characters)",
          mobileNumber: "Mobile must be +91 followed by 10 digits",
          ucc: "UCC must contain 1–32 characters",
          totp: "TOTP must be exactly 6 digits from your registered authenticator",
          mpin: "MPIN must be exactly 6 digits",
        };
        const issues = [
          ...new Set(
            parsed.error.issues.map((issue) =>
              Object.hasOwn(hints, String(issue.path[0]))
                ? hints[String(issue.path[0])]
                : "Unexpected or missing login fields",
            ),
          ),
        ];
        fail(422, `[KOTAK_INPUT_INVALID] ${issues.join(". ")}.`);
      }
      const input = parsed.data!,
        session = res.locals.session;
      await reserveBrokerRequestBudget(store, session.user_id, production);
      await reserveBrokerRequestBudget(store, session.user_id, production);
      await requestCoordinator.runExclusiveForUser(
        session.user_id,
        async () => {
          try {
            openPositionCache.delete(res.locals.session.user_id);
            await kotak.connect(
              session.user_id,
              session.token_hash,
              session.expires * 1000,
              input,
            );
            const brokerSession = kotak.executionSession(
              session.user_id,
              session.token_hash,
            );
            try {
              await recordBrokerConnected(
                store,
                session.user_id,
                "kotak",
                brokerSession.accountBinding,
              );
            } catch (error) {
              kotak.disconnect(session.user_id);
              throw error;
            }
          } catch (error) {
            if (error instanceof KotakConnectionError) {
              throw error;
            }
            fail(
              502,
              "Kotak login failed. Verify token, TOTP, MPIN and host. Credentials are not saved.",
            );
          }
        },
      );
      res.json({ connected: true });
    },
  );
  app.delete(
    ["/api/paper/kotak/connect", "/api/brokers/kotak/connect"],
    async (req, res) => {
      kotak.disconnect(res.locals.session.user_id);
      openPositionCache.delete(res.locals.session.user_id);
      await recordBrokerDisconnected(
        store,
        res.locals.session.user_id,
        "kotak",
      );
      res.json({ connected: false });
    },
  );
  /** Read broker authentication only. Unlike a virtual-wallet read, this never initializes a ledger. */
  app.get("/api/brokers/kotak/status", (_req, res) => {
    const session = res.locals.session;
    res.json({
      connected: kotak.isConnected(session.user_id, session.token_hash),
    });
  });
  app.get("/api/paper/:broker", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      session = res.locals.session;
    res.json({
      broker,
      connected: isPaperDataBrokerConnected(
        session.user_id,
        broker,
        session.token_hash,
      ),
      ...(await withPaperAccountLedger(session.user_id, broker)),
    });
  });
  /** Search explicit current NSE metadata only; no order or quote fan-out. Never accept a client URL. */
  app.post(
    ["/api/market/instruments", "/api/paper/:broker/instruments"],
    async (req, res) => {
      const workspaceRequest = z
        .object({
          experience: workspaceExperienceSchema.optional(),
          asOf: z.iso.date().optional(),
        })
        .passthrough()
        .parse(req.body);
      const instrumentBody = { ...req.body };
      delete instrumentBody.experience;
      delete instrumentBody.asOf;
      const broker = paperBrokerSchema.parse(req.params.broker || "kotak"),
        input = instrumentSearchSchema.parse(instrumentBody),
        session = res.locals.session;
      if (
        input.query.length < 2 &&
        !(broker === "kotak" && input.market === "cash")
      ) {
        fail(422, "Enter at least two characters for this instrument search.");
      }
      const dataMode = await resolveWorkspaceDataMode(
        workspaceRequest.experience,
        session,
      );
      if (dataMode === "historical") {
        if (input.market !== "options") {
          fail(422, "Use the stored-instrument API for historical cash data.");
        }
        const storedUnderlyings = await searchStoredOptionUnderlyings(
          store,
          session.user_id,
          input.query,
          workspaceRequest.asOf,
        );
        const underlyings =
          workspaceRequest.experience === "simulator"
            ? storedUnderlyings.filter((symbol) => simulatorIndexes.has(symbol))
            : storedUnderlyings;
        res.json({
          items: [],
          underlyings,
          expiries: [],
          total: underlyings.length,
          nextOffset: null,
          source: "stored-database",
          dataMode,
        });
        return;
      }
      if (
        !isPaperDataBrokerConnected(session.user_id, broker, session.token_hash)
      ) {
        fail(409, "Connect the selected broker before instrument search.");
      }
      await requestCoordinator.runQueuedForUser(
        session.user_id,
        AbortSignal.timeout(60000),
        async () => {
          if (!catalog.isFresh(input.market)) {
            try {
              await marketData.prepareInstruments(
                { userId: session.user_id, sessionHash: session.token_hash },
                input.market,
                () =>
                  reserveBrokerRequestBudget(
                    store,
                    session.user_id,
                    production,
                  ),
              );
            } catch {
              fail(
                502,
                "Instrument master unavailable or unsupported. No guessed contracts were substituted.",
              );
            }
          }
          if (
            !isPaperDataBrokerConnected(
              session.user_id,
              broker,
              session.token_hash,
            )
          ) {
            fail(409, "Broker disconnected during instrument search.");
          }
          res.json(catalog.search(input));
        },
      );
    },
  );
  /** Kotak-only current chain: master resolves tokens, one metered quote batch prices a page.
   * No execution adapter participates. An empty expiry requests metadata only.
   */
  app.post(
    ["/api/market/option-chain", "/api/paper/kotak/option-chain"],
    async (req, res) => {
      const input = z
        .object({
          underlying: z.string().trim().toUpperCase().min(2).max(40),
          expiryDate: z.iso.date().optional(),
          offset: z.number().int().min(0).max(250000).default(0),
          experience: workspaceExperienceSchema.optional(),
          asOf: z.iso.date().optional(),
        })
        .strict()
        .parse(req.body);
      const session = res.locals.session;
      if (
        input.experience === "simulator" &&
        !simulatorIndexes.has(input.underlying)
      ) {
        fail(422, "Historical simulator supports index options only.");
      }
      const dataMode = await resolveWorkspaceDataMode(
        input.experience,
        session,
      );
      if (dataMode === "historical") {
        const result = await readOptionChainSnapshot(store, {
          userId: session.user_id,
          underlying: input.underlying,
          expiryDate: input.expiryDate,
          offset: input.offset,
          asOf: input.asOf,
          closingOnly: input.experience === "chain",
        });
        if (!result) {
          fail(
            404,
            input.experience === "chain"
              ? "No imported closing option-chain data exists for this selection. Import NSE F&O bhavcopy data; equity/index history cannot supply option premiums."
              : "No stored broker option-chain snapshot exists for this selection. Connect the active broker during market hours to capture real prices first.",
          );
        }
        res.json(result);
        return;
      }
      if (!marketData.isConnected(session.user_id, session.token_hash)) {
        fail(409, "Connect the selected market-data provider first.");
      }
      await requestCoordinator.runExclusiveForUser(
        session.user_id,
        async () => {
          if (!catalog.isFresh("options")) {
            try {
              await marketData.prepareInstruments(
                { userId: session.user_id, sessionHash: session.token_hash },
                "options",
                () =>
                  reserveBrokerRequestBudget(
                    store,
                    session.user_id,
                    production,
                  ),
              );
            } catch {
              fail(
                502,
                "Provider option instrument master unavailable. No alternative data was substituted.",
              );
            }
          }
          const result = catalog.search({
            market: "options",
            query: input.underlying,
            underlying: input.underlying,
            expiryDate: input.expiryDate,
            offset: input.offset,
          });
          if (!marketData.isConnected(session.user_id, session.token_hash)) {
            fail(
              409,
              "Market-data provider disconnected during chain discovery.",
            );
          }
          if (!input.expiryDate) {
            res.json({
              ...result,
              items: [],
              source: marketData.id,
              receivedAt: Date.now(),
            });
            return;
          }
          if (input.expiryDate < paperTradingDay(Date.now())) {
            fail(422, "Choose a current, unexpired option contract.");
          }
          if (!result.items.length) {
            res.json({
              ...result,
              source: marketData.id,
              receivedAt: Date.now(),
            });
            return;
          }
          await reserveBrokerRequestBudget(store, session.user_id, production);
          let quotes;
          try {
            quotes = await marketData.getQuoteSnapshots(
              session.user_id,
              session.token_hash,
              result.items.map((item) => item.instrument),
            );
          } catch {
            // Discovery remains useful when an illiquid quote batch is unavailable.
            // Return exact master contracts with unknown prices; the shared feed can price them.
            res.json({
              ...result,
              items: result.items.map((item) => ({
                ...item,
                price: null,
                bid: null,
                ask: null,
                openInterest: null,
                stale: true,
              })),
              source: marketData.id,
              receivedAt: Date.now(),
              warning:
                "Initial quotes unavailable; waiting for streamed prices. No prices were substituted.",
            });
            return;
          }
          const response = {
            ...result,
            items: result.items.map((item, index) => ({
              ...item,
              ...quotes[index],
            })),
            source: marketData.id,
            receivedAt: Date.now(),
            dataMode: "live" as const,
            observedAt: Date.now(),
          };
          await saveOptionChainSnapshot(store, {
            userId: session.user_id,
            provider: marketData.id,
            underlying: input.underlying,
            expiryDate: input.expiryDate,
            offset: input.offset,
            observedAt: response.observedAt,
            chain: response,
          });
          res.json(response);
        },
      );
    },
  );
  app.post("/api/paper/:broker/orders", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      input = paperOrderInput.parse(req.body),
      session = res.locals.session;
    if (broker === "kotak" && !/^\d{1,15}$/.test(input.instrument)) {
      fail(422, "Kotak requires an NSE instrument token (pSymbol).");
    }
    if (
      !isPaperDataBrokerConnected(session.user_id, broker, session.token_hash)
    ) {
      fail(409, "Connect the selected data broker first.");
    }
    res.json(
      await withPaperAccountLedger(session.user_id, broker, (state) => {
        catalog.validate(input, input.quantity);
        if (
          broker === "kotak" &&
          state.orders.some(
            (o) =>
              o.instrument === input.instrument &&
              Boolean(o.option) === Boolean(input.option) &&
              paperInstrumentKey(o) !== paperInstrumentKey(input),
          )
        ) {
          throw new Error(
            "This Kotak token is already bound to a different contract.",
          );
        }
        const instruments = new Set([
          ...state.orders
            .filter((o) => o.state === "open")
            .map(paperInstrumentKey),
          ...Object.keys(state.positions).filter(
            (k) => state.positions[k].quantity,
          ),
          paperInstrumentKey(input),
        ]);
        if (instruments.size > 4) {
          throw new Error(
            "This paper wallet supports four active instruments.",
          );
        }
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
      await withPaperAccountLedger(
        res.locals.session.user_id,
        broker,
        (state) => {
          const order = state.orders.find((order) => order.key === key);
          if (order) {
            catalog.validate(order, input.quantity);
          }
          modifyPaperOrder(
            state,
            key,
            input.quantity,
            input.limitPaise,
            Date.now(),
          );
        },
      ),
    );
  });
  app.post("/api/paper/:broker/orders/:key/cancel", async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      key = z.string().uuid().parse(req.params.key);
    res.json(
      await withPaperAccountLedger(
        res.locals.session.user_id,
        broker,
        (state) => cancelPaperOrder(state, key, Date.now()),
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
    const before = await withPaperAccountLedger(session.user_id, broker);
    const contracts = new Map<
      string,
      Pick<PaperInput, "instrument" | "option" | "masterToken">
    >();
    for (const order of before.orders) {
      if (
        order.state === "open" ||
        before.positions[paperInstrumentKey(order)]?.quantity
      ) {
        contracts.set(paperInstrumentKey(order), order);
      }
    }
    if (input.instrument) {
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
    }
    if (contracts.size > 4) {
      fail(422, "Refresh supports at most four active instruments.");
    }
    if (
      !isPaperDataBrokerConnected(session.user_id, broker, session.token_hash)
    ) {
      fail(409, "Selected broker disconnected. Paper matching is paused.");
    }
    const quotes: PaperQuote[] = [];
    await requestCoordinator.runExclusiveForUser(session.user_id, async () => {
      // A manual draft must not bypass validation of a previously master-selected held contract.
      for (const order of before.orders) {
        if (
          (order.state === "open" ||
            before.positions[paperInstrumentKey(order)]?.quantity) &&
          (!order.option ||
            order.option.expiryDate >= paperTradingDay(Date.now()))
        ) {
          try {
            catalog.validate(order);
          } catch {
            fail(
              409,
              "Reload instrument search before matching master-selected contracts.",
            );
          }
        }
      }
      for (const [key, contract] of contracts) {
        const { instrument, option } = contract;
        if (option && option.expiryDate < paperTradingDay(Date.now())) {
          continue;
        }
        try {
          catalog.validate(contract);
        } catch {
          fail(
            409,
            "Selected instrument master expired or changed. Reload instrument search before matching.",
          );
        }
        await reserveBrokerRequestBudget(store, session.user_id, production);
        try {
          quotes.push({
            ...(await marketData.getPaperFillQuote(
              session.user_id,
              session.token_hash,
              instrument,
              option ? "nse_fo" : "nse_cm",
            )),
            instrument: key,
          });
        } catch {
          fail(
            502,
            "Broker quote unavailable. No orders matched in this refresh. Verify connection and instrument.",
          );
        }
      }
    });
    const state = await withPaperAccountLedger(
      session.user_id,
      broker,
      (value) => matchPaperOrders(value, quotes, Date.now()),
    );
    res.json({
      ...state,
      quotes,
      stale: quotes.some((quote) => !freshPaperQuote(quote, Date.now())),
    });
  });
  /** Live monitoring reads only funds and open positions. Order/trade history is intentionally
   * excluded: positions are marked from their exact Kotak option tokens instead. */
  app.post(
    ["/api/paper/kotak/reports", "/api/brokers/kotak/overview"],
    async (_req, res) => {
      const session = res.locals.session;
      if (!kotak.isConnected(session.user_id, session.token_hash)) {
        fail(409, "Connect Kotak first.");
      }
      const cachedPositions = openPositionCache.get(session.user_id);
      const reusablePositions =
        cachedPositions &&
        cachedPositions.sessionHash === session.token_hash &&
        cachedPositions.expiresAt > Date.now()
          ? cachedPositions.rows
          : null;
      const result: Record<string, unknown> = {
        source: "kotak",
        readOnly: true,
        observedAt: Date.now(),
      };
      await requestCoordinator.runQueuedForUser(
        session.user_id,
        AbortSignal.timeout(30000),
        async () => {
          if (!kotak.isConnected(session.user_id, session.token_hash)) {
            fail(409, "Connect Kotak first.");
          }
          for (const kind of ["limits", "positions"] as const) {
            await reserveBrokerRequestBudget(
              store,
              session.user_id,
              production,
            );
            try {
              result[kind] = {
                rows:
                  kind === "positions"
                    ? await (async () => {
                        const positions =
                          reusablePositions ??
                          (await kotak.getPortfolioRows(
                            session.user_id,
                            session.token_hash,
                            "positions",
                          ));
                        if (!reusablePositions) {
                          openPositionCache.set(session.user_id, {
                            sessionHash: session.token_hash,
                            expiresAt: Date.now() + 15 * 60 * 1000,
                            rows: positions,
                          });
                        }
                        const bySegment = new Map<
                          "nse_cm" | "nse_fo",
                          string[]
                        >();
                        for (const position of positions) {
                          const segment = position.exchange as
                            "nse_cm" | "nse_fo";
                          if (
                            (segment === "nse_cm" || segment === "nse_fo") &&
                            /^\d{1,15}$/.test(position.instrumentToken)
                          ) {
                            bySegment.set(segment, [
                              ...(bySegment.get(segment) || []),
                              position.instrumentToken,
                            ]);
                          }
                        }
                        const marks = new Map<string, number>();
                        for (const [segment, tokens] of bySegment) {
                          const uniqueTokens = [...new Set(tokens)];
                          for (
                            let offset = 0;
                            offset < uniqueTokens.length;
                            offset += 50
                          ) {
                            await reserveBrokerRequestBudget(
                              store,
                              session.user_id,
                              production,
                            );
                            for (const quote of await marketData.getQuoteSnapshots(
                              session.user_id,
                              session.token_hash,
                              uniqueTokens.slice(offset, offset + 50),
                              segment,
                            )) {
                              if (quote.price !== null && !quote.stale) {
                                marks.set(
                                  `${segment}|${quote.instrument}`,
                                  quote.price,
                                );
                              }
                            }
                          }
                        }
                        return positions.map(
                          ({
                            instrumentToken,
                            pnlBase,
                            pnlPerMark,
                            ...position
                          }) => {
                            const markPrice =
                              marks.get(
                                `${position.exchange}|${instrumentToken}`,
                              ) ?? position.markPrice;
                            return {
                              ...position,
                              instrumentToken,
                              pnlBase,
                              pnlPerMark,
                              markPrice,
                              pnl:
                                markPrice !== null &&
                                pnlBase !== null &&
                                pnlPerMark !== null
                                  ? pnlBase + pnlPerMark * markPrice
                                  : position.pnl !== null &&
                                      position.markPrice !== null &&
                                      markPrice !== null &&
                                      pnlPerMark !== null
                                    ? position.pnl +
                                      (markPrice - position.markPrice) *
                                        pnlPerMark
                                    : position.pnl,
                            };
                          },
                        );
                      })()
                    : await kotak.getAccountReport(
                        session.user_id,
                        session.token_hash,
                        kind,
                      ),
                error: null,
              };
            } catch {
              result[kind] = {
                rows: null,
                error: `Kotak ${kind} unavailable; not assumed empty.`,
              };
            }
          }
        },
      );
      res.json(result);
    },
  );
  app.post(
    ["/api/market/live-feed", "/api/paper/kotak/live-feed"],
    async (req, res) => {
      if (!marketData.capabilities.live) {
        fail(422, "Selected data provider does not support live streaming.");
      }
      const input = z
        .object({
          instruments: z
            .array(z.string().regex(/^\d{1,15}$/))
            .max(50)
            .default([]),
        })
        .strict()
        .parse(req.body);
      const session = res.locals.session;
      const cached = openPositionCache.get(session.user_id);
      // A chain subscription does not require a connected trading account or position book.
      // Only merge account tokens from the same active app session.
      const rows =
        cached &&
        cached.sessionHash === session.token_hash &&
        cached.expiresAt > Date.now() &&
        kotak.isConnected(session.user_id, session.token_hash)
          ? cached.rows
          : [];
      const positions = rows
        .filter(
          (row) =>
            row.quantity !== 0 &&
            /^(nse_cm|nse_fo)$/.test(row.exchange) &&
            /^\d{1,15}$/.test(row.instrumentToken),
        )
        .map((row) => ({
          exchange: row.exchange as "nse_cm" | "nse_fo",
          instrument: row.instrumentToken,
        }));
      const instruments = [
        ...new Map(
          [
            ...positions,
            ...input.instruments.map((instrument) => ({
              exchange: "nse_fo" as const,
              instrument,
            })),
          ].map((row) => [`${row.exchange}|${row.instrument}`, row]),
        ).values(),
      ];
      if (positions.length > 50) {
        fail(
          422,
          "More than 50 open positions require a larger feed subscription; no partial portfolio is streamed.",
        );
      }
      if (!instruments.length) {
        fail(409, "No quoteable open positions were returned by Kotak.");
      }
      await requestCoordinator.runExclusiveForUser(
        session.user_id,
        async () => {
          await reserveBrokerRequestBudget(store, session.user_id, production);
          await reserveBrokerRequestBudget(store, session.user_id, production);
          res.json(
            marketData.startPriceFeed(session.user_id, session.token_hash, {
              kind: "touchline",
              mode: "subscribe",
              instruments,
            }),
          );
        },
      );
    },
  );
  app.get("/api/market/provider", (_req, res) => {
    const session = res.locals.session;
    res.json({
      source: marketData.id,
      capabilities: marketData.capabilities,
      connected: marketData.isConnected(session.user_id, session.token_hash),
    });
  });
  app.get("/api/market/feed", (_req, res) => {
    const session = res.locals.session;
    res.json({
      ...marketData.readPriceFeed(session.user_id, session.token_hash),
      source: marketData.id,
    });
  });
  app.delete("/api/market/feed", (_req, res) => {
    const session = res.locals.session;
    marketData.stopPriceFeed(session.user_id, session.token_hash);
    res.json({
      source: marketData.id,
      state: "stopped",
      records: [],
      notifications: [],
    });
  });
  /** Owner-scoped account reads never create or modify a paper wallet or submit orders. */
  app.post("/api/portfolio/:broker/refresh", limit, async (req, res) => {
    const broker = paperBrokerSchema.parse(req.params.broker),
      session = res.locals.session;
    if (!kotak.isConnected(session.user_id, session.token_hash)) {
      fail(409, "Connect the selected broker first.");
    }
    const result: Record<string, unknown> = {
      broker,
      readOnly: true,
      observedAt: Date.now(),
    };
    await requestCoordinator.runExclusiveForUser(session.user_id, async () => {
      for (const kind of ["positions", "holdings"] as const) {
        await reserveBrokerRequestBudget(store, session.user_id, production);
        try {
          const rows = await kotak.getPortfolioRows(
            session.user_id,
            session.token_hash,
            kind,
          );
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
