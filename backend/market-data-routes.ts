/** Authenticated broker connections, account reports and market-data endpoints. */
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./database.js";
import type { OptionCandleStore } from "./option-candle-store.js";
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
  readBuilderSnapshot,
  readOptionChainSnapshot,
  saveOptionChainSnapshot,
  searchStoredOptionUnderlyings,
} from "./option-chain-history.js";
import {
  OPTION_INDEX_UNDERLYINGS,
  regularMarketSessionOpen,
  tradingDay,
  type MarketDataBroker,
} from "./market-contracts.js";

/** Register broker-read and market-data endpoints after authentication and CSRF middleware. */
export function registerMarketDataRoutes(
  app: Express,
  store: Store,
  optionHistory: OptionCandleStore,
  requestCoordinator: BrokerRequestCoordinator,
  kotak: Pick<
    KotakMarketDataClient,
    | "connect"
    | "disconnect"
    | "isConnected"
    | "getPortfolioRows"
    | "getAccountReport"
    | "executionSession"
    | "savedSession"
  >,
  production: boolean,
  marketData: MarketDataProvider,
  savedSessions?: import("./broker-session-store.js").BrokerSessionStore,
  onConnected?: (args: {
    userId: string;
    sessionHash: string;
    brokerId: string;
    accountBinding: string;
  }) => Promise<void>,
  zerodha?: Pick<
    ReturnType<
      typeof import("./zerodha-connection.js").createZerodhaConnection
    >,
    "optionSnapshot" | "isConnected"
  >,
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
  const workspaceExperienceSchema = z.enum(["builder", "chain"]);
  /** Prefer the active provider whenever its authenticated adapter is available,
   * including after market close. Otherwise use durable snapshots for either
   * current-chain screen. For a stock underlying specifically, off-market hours
   * still force the NSE-stored chain even with a connected broker: individual
   * stock option feeds are unreliable once the exchange session ends, unlike the
   * handful of index underlyings a broker keeps serving a stable last quote for.
   */
  async function resolveWorkspaceDataMode(
    experience: z.infer<typeof workspaceExperienceSchema> | undefined,
    session: { user_id: string; token_hash: string },
    underlying?: string,
  ) {
    const active = await store.transaction((query) =>
      resolveActiveBroker(query, session.user_id),
    );
    if (active.provider !== marketData.id) {
      if (experience) {
        return "historical" as const;
      }
      fail(
        409,
        `The active broker (${active.provider}) has no configured market-data adapter.`,
      );
    }
    if (!marketData.isConnected(session.user_id, session.token_hash)) {
      if (experience) {
        return "historical" as const;
      }
      fail(409, "Reconnect the active broker before loading live market data.");
    }
    if (
      experience &&
      underlying &&
      !OPTION_INDEX_UNDERLYINGS.has(underlying) &&
      !regularMarketSessionOpen(Date.now())
    ) {
      return "historical" as const;
    }
    return "live" as const;
  }
  /** Only the browser session that logged into Kotak may use its cached broker credentials. */
  function isBrokerConnected(
    userId: string,
    broker: MarketDataBroker,
    sessionHash: string,
  ) {
    return broker === "kotak" && marketData.isConnected(userId, sessionHash);
  }
  /** Login makes two documented authentication calls, never an order request. No raw secrets in responses. */
  app.post("/api/brokers/kotak/connect", async (req, res) => {
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
    let portfolioWarning: string | null = null;
    const input = parsed.data!,
      session = res.locals.session;
    await reserveBrokerRequestBudget(store, session.user_id, production);
    await reserveBrokerRequestBudget(store, session.user_id, production);
    await requestCoordinator.runExclusiveForUser(session.user_id, async () => {
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
          const brokerId = await recordBrokerConnected(
            store,
            session.user_id,
            "kotak",
            brokerSession.accountBinding,
          );
          const saved = kotak.savedSession(session.user_id, session.token_hash);
          if (saved) {
            await savedSessions?.save(session, "kotak", saved.expires, saved);
          }
          try {
            await onConnected?.({
              userId: session.user_id,
              sessionHash: session.token_hash,
              brokerId,
              accountBinding: brokerSession.accountBinding,
            });
          } catch {
            // Authentication succeeded and remains usable. The failed first sync is
            // visible in Portfolio and can be retried without reauthorizing.
            portfolioWarning =
              "Broker connected, but the first portfolio synchronization was unavailable.";
          }
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
    });
    res.json({ connected: true, portfolioWarning });
  });
  app.delete("/api/brokers/kotak/connect", async (req, res) => {
    kotak.disconnect(res.locals.session.user_id);
    await savedSessions?.remove(res.locals.session.user_id, "kotak");
    openPositionCache.delete(res.locals.session.user_id);
    await recordBrokerDisconnected(store, res.locals.session.user_id, "kotak");
    res.json({ connected: false });
  });
  /** Read broker authentication without mutating account state. */
  app.get("/api/brokers/kotak/status", (_req, res) => {
    const session = res.locals.session;
    res.json({
      connected: kotak.isConnected(session.user_id, session.token_hash),
      expiresAt:
        kotak.savedSession(session.user_id, session.token_hash)?.expires ??
        null,
    });
  });
  /** Search explicit current NSE metadata only; no order or quote fan-out. Never accept a client URL. */
  // Zerodha chain reads do not enter the Kotak feed or execution adapters.
  // A failed quote read may replay only this owner's saved snapshot from this provider.
  app.post(
    ["/api/market/instruments", "/api/market/option-chain"],
    async (req, res, next) => {
      if (!["builder", "chain"].includes(req.body?.experience)) {
        next();
        return;
      }
      const session = res.locals.session;
      const active = await store.transaction((query) =>
        resolveActiveBroker(query, session.user_id),
      );
      if (active.provider !== "zerodha") {
        next();
        return;
      }
      const isChain = req.path.endsWith("option-chain");
      const input = z
        .object({
          query: z.string().trim().toUpperCase().min(2).max(40),
          underlying: z.string().trim().toUpperCase().min(2).max(40).optional(),
          expiryDate: z.iso.date().optional(),
          offset: z.number().int().min(0).max(250000).default(0),
        })
        .parse({
          ...req.body,
          query: isChain ? req.body.underlying : req.body.query,
        });
      try {
        if (!zerodha) {
          fail(409, "Zerodha quote reader is unavailable.");
        }
        const result = await requestCoordinator.runQueuedForUser(
          session.user_id,
          AbortSignal.timeout(60000),
          async () => {
            const value = await zerodha!.optionSnapshot(
              session.user_id,
              session.token_hash,
              input,
              () =>
                reserveBrokerRequestBudget(store, session.user_id, production),
            );
            const current = await store.transaction((query) =>
              resolveActiveBroker(query, session.user_id),
            );
            if (current.provider !== active.provider) {
              fail(409, "Active broker changed; reload the chain.");
            }
            return value;
          },
        );
        if (isChain && input.expiryDate && result.quotesUnavailable) {
          const saved = await readBuilderSnapshot(optionHistory, {
            userId: session.user_id,
            provider: "zerodha",
            underlying: input.underlying!,
            expiryDate: input.expiryDate,
            offset: input.offset,
          });
          if (
            saved?.items.some(
              (item) => typeof item.price === "number" && item.price > 0,
            )
          ) {
            res.json({
              ...saved,
              expiries: result.expiries,
              warning: `Zerodha quotes are unavailable; check the Kite app's market-data access. ${saved.warning}`,
            });
            return;
          }
        }
        if (
          isChain &&
          input.expiryDate &&
          result.items.some((item) => item.price !== null)
        ) {
          await saveOptionChainSnapshot(store, {
            userId: session.user_id,
            provider: "zerodha",
            underlying: input.underlying!,
            expiryDate: input.expiryDate,
            offset: input.offset,
            observedAt: result.observedAt,
            chain: result,
          });
        }
        res.json(result);
      } catch (error) {
        const current = await store.transaction((query) =>
          resolveActiveBroker(query, session.user_id),
        );
        if (current.provider !== active.provider) {
          throw error;
        }
        if (!isChain) {
          const rows = (
            await searchStoredOptionUnderlyings(
              store,
              session.user_id,
              input.query,
            )
          ).map((underlying) => ({ underlying }));
          if (!rows.length) {
            throw error;
          }
          res.json({
            items: [],
            underlyings: rows.map((row) => row.underlying),
            expiries: [],
            total: rows.length,
            nextOffset: null,
            source: "zerodha",
            dataMode: "historical",
          });
          return;
        }
        const stored = await readBuilderSnapshot(optionHistory, {
          userId: session.user_id,
          provider: "zerodha",
          underlying: input.underlying!,
          expiryDate: input.expiryDate,
          offset: input.offset,
        });
        const expiries =
          stored?.expiries
            .filter((day) => day >= tradingDay(Date.now()))
            .slice(0, 2) ?? [];
        if (
          !stored ||
          !expiries.length ||
          (input.expiryDate && !expiries.includes(input.expiryDate))
        ) {
          throw error;
        }
        res.json({
          ...stored,
          expiries,
          warning: stored.warning,
        });
      }
    },
  );
  /** Resolve the underlying independently from option premiums. Failure stays
   * null because a derivative premium is never a valid substitute for spot.
   */
  async function loadUnderlyingPrice(
    session: { user_id: string; token_hash: string },
    underlying: string,
  ) {
    try {
      if (!catalog.isFresh("cash")) {
        await marketData.prepareInstruments(
          { userId: session.user_id, sessionHash: session.token_hash },
          "cash",
          () => reserveBrokerRequestBudget(store, session.user_id, production),
        );
      }
      const cash = catalog
        .search({
          market: "cash",
          query: underlying,
          underlying,
          offset: 0,
        })
        .items.find((item) => item.symbol === underlying);
      if (!cash) {
        return null;
      }
      await reserveBrokerRequestBudget(store, session.user_id, production);
      return (
        (
          await marketData.getQuoteSnapshots(
            session.user_id,
            session.token_hash,
            [cash.instrument],
            "nse_cm",
          )
        )[0]?.price ?? null
      );
    } catch {
      return null;
    }
  }
  app.post("/api/market/instruments", async (req, res) => {
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
    const broker: MarketDataBroker = "kotak",
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
      const underlyings = storedUnderlyings;
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
    if (!isBrokerConnected(session.user_id, broker, session.token_hash)) {
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
                reserveBrokerRequestBudget(store, session.user_id, production),
            );
          } catch {
            fail(
              502,
              "Instrument master unavailable or unsupported. No guessed contracts were substituted.",
            );
          }
        }
        if (!isBrokerConnected(session.user_id, broker, session.token_hash)) {
          fail(409, "Broker disconnected during instrument search.");
        }
        res.json(catalog.search(input));
      },
    );
  });
  /** Active-provider current chain. Prefer a provider's native full-chain API;
   * otherwise resolve exact master tokens and price one bounded page. No
   * execution adapter participates. An empty expiry requests metadata only.
   */
  app.post("/api/market/option-chain", async (req, res) => {
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
    const dataMode = await resolveWorkspaceDataMode(
      input.experience,
      session,
      input.underlying,
    );
    if (dataMode === "historical") {
      const active =
        input.experience === "builder"
          ? await store.transaction((query) =>
              resolveActiveBroker(query, session.user_id),
            )
          : null;
      const result = active
        ? await readBuilderSnapshot(optionHistory, {
            userId: session.user_id,
            provider: active.provider,
            underlying: input.underlying,
            expiryDate: input.expiryDate,
            offset: input.offset,
          })
        : await readOptionChainSnapshot(optionHistory, {
            userId: session.user_id,
            underlying: input.underlying,
            expiryDate: input.expiryDate,
            offset: input.offset,
            asOf: input.asOf,
            closingOnly: input.experience === "chain",
          });
      if (!result) {
        return fail(
          404,
          input.experience === "chain"
            ? "No imported closing option-chain data exists for this selection. Import NSE F&O bhavcopy data; equity/index history cannot supply option premiums."
            : "No stored option-chain data exists for this scrip. Import its F&O option data or capture its broker chain during market hours. Cash-price history cannot supply option premiums.",
        );
      }
      if (input.experience === "builder") {
        const expiries = result.expiries
          .filter((day) => day >= tradingDay(Date.now()))
          .slice(0, 2);
        if (
          !expiries.length ||
          (input.expiryDate && !expiries.includes(input.expiryDate))
        ) {
          fail(
            404,
            "No saved unexpired chain is available. Reconnect the active broker and refresh quotes.",
          );
        }
        res.json({
          ...result,
          expiries,
          warning:
            ("warning" in result ? result.warning : undefined) ??
            "Broker disconnected. Showing a saved snapshot; prices are not live.",
        });
      } else {
        res.json(result);
      }
      return;
    }
    if (!marketData.isConnected(session.user_id, session.token_hash)) {
      fail(409, "Connect the selected market-data provider first.");
    }
    try {
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
          if (marketData.getOptionExpiries) {
            try {
              await reserveBrokerRequestBudget(
                store,
                session.user_id,
                production,
              );
              result.expiries = await marketData.getOptionExpiries(
                session.user_id,
                session.token_hash,
                input.underlying,
              );
            } catch {
              // A current validated master remains a safe metadata fallback.
              // Prices still fail closed if both native-chain and quotes fail.
            }
          }
          if (input.experience === "builder") {
            result.expiries = result.expiries
              .filter((day) => day >= tradingDay(Date.now()))
              .slice(0, 2);
            if (
              input.expiryDate &&
              !result.expiries.includes(input.expiryDate)
            ) {
              fail(422, "Choose the current or next available expiry.");
            }
          }
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
              dataMode:
                input.experience === "builder" &&
                !regularMarketSessionOpen(Date.now())
                  ? "historical"
                  : "live",
            });
            return;
          }
          if (input.expiryDate < tradingDay(Date.now())) {
            fail(422, "Choose a current, unexpired option contract.");
          }
          if (marketData.getOptionChain && input.offset === 0) {
            try {
              await reserveBrokerRequestBudget(
                store,
                session.user_id,
                production,
              );
              const nativeChain = await marketData.getOptionChain(
                session.user_id,
                session.token_hash,
                {
                  underlying: input.underlying,
                  expiryDate: input.expiryDate,
                  count: 100,
                },
              );
              const marketClosed =
                input.experience === "builder" &&
                !regularMarketSessionOpen(Date.now());
              const response = {
                underlyings: result.underlyings,
                expiries: result.expiries,
                items: nativeChain.items,
                total: nativeChain.total,
                nextOffset: null,
                source: marketData.id,
                receivedAt: Date.now(),
                observedAt: nativeChain.observedAt,
                underlyingPrice:
                  input.experience === "builder"
                    ? await loadUnderlyingPrice(session, input.underlying)
                    : null,
                dataMode: marketClosed
                  ? ("historical" as const)
                  : ("live" as const),
                warning: marketClosed
                  ? `Market closed. ${nativeChain.warning ?? "Broker snapshot fetched now; exchange trade freshness is unverified."}`
                  : nativeChain.warning,
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
              return;
            } catch {
              // Providers may temporarily withdraw the native endpoint. Continue
              // through the exact-contract quote path instead of fabricating data.
            }
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
            if (input.experience === "builder") {
              const stored = await readBuilderSnapshot(optionHistory, {
                userId: session.user_id,
                provider: marketData.id,
                underlying: input.underlying,
                expiryDate: input.expiryDate,
                offset: input.offset,
              });
              if (stored) {
                res.json({
                  ...stored,
                  expiries: result.expiries,
                  warning: stored.warning,
                });
                return;
              }
            }
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
          // Stock spot is a separate cash instrument; never derive it from an option premium.
          const underlyingPrice =
            input.experience === "builder"
              ? await loadUnderlyingPrice(session, input.underlying)
              : null;
          const response = {
            ...result,
            items: result.items.map((item, index) => ({
              ...item,
              ...quotes[index],
            })),
            source: marketData.id,
            receivedAt: Date.now(),
            dataMode:
              input.experience === "builder" &&
              !regularMarketSessionOpen(Date.now())
                ? ("historical" as const)
                : ("live" as const),
            observedAt: Date.now(),
            underlyingPrice,
            ...(input.experience === "builder" &&
            !regularMarketSessionOpen(Date.now())
              ? {
                  warning:
                    "Market closed. Broker snapshot fetched now; exchange trade freshness is unverified.",
                }
              : {}),
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
    } catch (error) {
      if (input.experience !== "builder" || res.headersSent) {
        throw error;
      }
      const active = await store.transaction((query) =>
        resolveActiveBroker(query, session.user_id),
      );
      if (active.provider !== marketData.id) {
        throw error;
      }
      const saved = await readBuilderSnapshot(optionHistory, {
        userId: session.user_id,
        provider: active.provider,
        underlying: input.underlying,
        expiryDate: input.expiryDate,
        offset: input.offset,
      });
      const expiries =
        saved?.expiries
          .filter((day) => day >= tradingDay(Date.now()))
          .slice(0, 2) ?? [];
      if (
        !saved ||
        !expiries.length ||
        (input.expiryDate && !expiries.includes(input.expiryDate))
      ) {
        throw error;
      }
      res.json({
        ...saved,
        expiries,
        warning: saved.warning,
      });
    }
  });
  /** Live monitoring reads only funds and open positions. Order/trade history is intentionally
   * excluded: positions are marked from their exact Kotak option tokens instead. */
  app.post("/api/brokers/kotak/overview", async (_req, res) => {
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
        for (const kind of ["limits", "positions", "holdings"] as const) {
          await reserveBrokerRequestBudget(store, session.user_id, production);
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
                  : kind === "holdings"
                    ? await kotak.getPortfolioRows(
                        session.user_id,
                        session.token_hash,
                        "holdings",
                      )
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
  });
  app.post("/api/market/live-feed", async (req, res) => {
    await resolveWorkspaceDataMode(undefined, res.locals.session);
    if (!marketData.capabilities.live) {
      fail(422, "Selected data provider does not support live streaming.");
    }
    const input = z
      .object({
        instruments: z
          .array(z.string().regex(/^\d{1,15}$/))
          .max(50)
          .default([]),
        // Separate from `instruments` (always nse_fo, the existing option-chain
        // subscription) so a stock/index cash quote can never be mistaken for an
        // F&O token; a live watchlist chart requests this one instead.
        cashInstruments: z
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
          ...input.cashInstruments.map((instrument) => ({
            exchange: "nse_cm" as const,
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
      fail(
        409,
        input.instruments.length || input.cashInstruments.length
          ? "None of the requested instruments could be subscribed."
          : "No quoteable open positions were returned by Kotak.",
      );
    }
    await requestCoordinator.runExclusiveForUser(session.user_id, async () => {
      await reserveBrokerRequestBudget(store, session.user_id, production);
      await reserveBrokerRequestBudget(store, session.user_id, production);
      res.json(
        marketData.startPriceFeed(session.user_id, session.token_hash, {
          kind: "touchline",
          mode: "subscribe",
          instruments,
        }),
      );
    });
  });
  app.get("/api/market/provider", (_req, res) => {
    const session = res.locals.session;
    res.json({
      source: marketData.id,
      capabilities: marketData.capabilities,
      connected: marketData.isConnected(session.user_id, session.token_hash),
    });
  });
  app.get("/api/market/feed", async (_req, res) => {
    const session = res.locals.session;
    await resolveWorkspaceDataMode(undefined, session);
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
  /** Owner-scoped account reads never submit orders. */
  app.post("/api/portfolio/kotak/refresh", limit, async (_req, res) => {
    const broker: MarketDataBroker = "kotak",
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
