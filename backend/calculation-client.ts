/** Strict private transport to the broker-isolated Python calculation service.
 * This adapter never carries user sessions, broker credentials or execution capabilities.
 */
import { z } from "zod";

const dailyBarSchema = z
  .object({
    date: z.iso.date(),
    open: z.number().positive().finite().max(100000000),
    high: z.number().positive().finite().max(100000000),
    low: z.number().positive().finite().max(100000000),
    close: z.number().positive().finite().max(100000000),
  })
  .strict()
  .refine(
    (bar) =>
      bar.high >= Math.max(bar.open, bar.close, bar.low) &&
      bar.low <= Math.min(bar.open, bar.close),
    "Invalid OHLC range",
  );
export const calculationBacktestSettingsSchema = z
  .object({
    template: z.enum(["ema", "rsi", "breakout"]),
    first: z.number().int().min(2).max(500),
    second: z.number().int().min(2).max(500),
    capital: z.number().min(100).max(10000000),
    allocation: z.number().positive().max(100),
    stop: z.number().positive().lt(100),
    target: z.number().positive().max(1000),
    fee: z.number().nonnegative().max(10000),
    slippage: z.number().nonnegative().max(500),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.template === "ema" && settings.first >= settings.second) {
      context.addIssue({
        code: "custom",
        message: "Fast EMA must be shorter than slow EMA.",
      });
    }
    if (
      settings.template === "rsi" &&
      (settings.second <= 30 || settings.second >= 100)
    ) {
      context.addIssue({
        code: "custom",
        message: "Exit RSI must be between 30 and 100.",
      });
    }
  });
export type CalculationBacktestSettings = z.infer<
  typeof calculationBacktestSettingsSchema
>;
export const payoffRequestSchema = z
  .object({
    legs: z
      .array(
        z
          .object({
            right: z.enum(["call", "put"]),
            side: z.enum(["buy", "sell"]),
            strike: z.number().positive().finite().max(10000000),
            quantity: z.number().int().positive().max(10000000),
            premium: z.number().nonnegative().finite().max(10000000),
            iv: z.number().nonnegative().finite().max(5),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    spot: z.number().positive().finite().max(10000000),
    days: z.number().nonnegative().finite().max(3650),
    rate: z.number().finite().min(-1).max(1),
    dividend: z.number().finite().min(0).max(1),
    ivShift: z.number().finite().min(-5).max(5),
    targetSpot: z.number().positive().finite().max(10000000),
    totalFees: z.number().nonnegative().finite().max(1000000),
  })
  .strict();
export type PayoffRequest = z.infer<typeof payoffRequestSchema>;

const finiteNumber = z.number().finite();
const backtestResultSchema = z
  .object({
    settings: calculationBacktestSettingsSchema,
    source: z.literal("historical daily OHLC"),
    from: z.iso.date(),
    to: z.iso.date(),
    endingEquity: finiteNumber,
    returnPercent: finiteNumber,
    drawdownPercent: finiteNumber.nonnegative(),
    winRate: finiteNumber.nonnegative().max(100).nullable(),
    profitFactor: finiteNumber.nonnegative().nullable(),
    totalFees: finiteNumber.nonnegative(),
    skippedEntries: z.number().int().nonnegative(),
    equity: z
      .array(z.object({ date: z.iso.date(), value: finiteNumber }).strict())
      .min(60)
      .max(10000),
    trades: z
      .array(
        z
          .object({
            signalDate: z.iso.date(),
            entryDate: z.iso.date(),
            exitDate: z.iso.date(),
            quantity: z.number().int().positive(),
            entry: finiteNumber.positive(),
            exit: finiteNumber.positive(),
            pnl: finiteNumber,
            entryFee: finiteNumber.nonnegative(),
            exitFee: finiteNumber.nonnegative(),
            reason: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
const payoffResultSchema = z
  .object({
    netDebit: finiteNumber,
    risk: z
      .object({
        maxProfit: finiteNumber.nullable(),
        maxLoss: finiteNumber.nonnegative().nullable(),
        unlimitedProfit: z.boolean(),
        unlimitedLoss: z.boolean(),
        breakevens: z.array(finiteNumber.nonnegative()).max(24),
      })
      .strict(),
    low: finiteNumber.positive(),
    high: finiteNumber.positive(),
    points: z
      .array(
        z
          .object({
            spot: finiteNumber.positive(),
            expiry: finiteNumber,
            scenario: finiteNumber,
          })
          .strict(),
      )
      .min(161)
      .max(200),
    target: z
      .object({
        pnl: finiteNumber,
        delta: finiteNumber,
        gamma: finiteNumber,
        theta: finiteNumber,
        vega: finiteNumber,
      })
      .strict(),
    targetExpiry: finiteNumber,
  })
  .strict();

export type PythonBacktestResult = z.infer<typeof backtestResultSchema>;
export type PythonPayoffResult = z.infer<typeof payoffResultSchema>;

const storedDailyStrategySchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(3).max(80),
    quantity: z.number().int().positive().max(10000),
    capital: finiteNumber.min(100).max(10000000),
    marginReserve: finiteNumber.nonnegative().max(10000000),
    stopLoss: finiteNumber.positive().max(10000000),
    targetProfit: finiteNumber.positive().max(10000000),
    slippageBps: finiteNumber.nonnegative().max(500),
    feePerOrder: finiteNumber.nonnegative().max(10000),
  })
  .strict();
const storedDailySessionSchema = z
  .object({
    source: z.literal("stored-eod"),
    model: z.literal("python-stored-daily-open-close-v1"),
    day: z.iso.date(),
    points: z.array(
      z
        .object({
          time: z.number().int().nonnegative(),
          pnl: finiteNumber,
          prices: z.array(finiteNumber.positive()).length(1),
          open: z.boolean(),
        })
        .strict(),
    ),
    fills: z.array(
      z
        .object({
          time: z.number().int().nonnegative(),
          leg: z.literal(0),
          action: z.enum(["buy", "sell"]),
          quantity: z.number().int().positive(),
          price: finiteNumber.positive(),
          fee: finiteNumber.nonnegative(),
          reason: z.string().min(1).max(160),
        })
        .strict(),
    ),
    pnl: finiteNumber,
    drawdown: finiteNumber.nonnegative(),
    totalFees: finiteNumber.nonnegative(),
    warnings: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();
const storedDailyResponseSchema = z
  .object({
    engineVersion: z.string().min(1).max(80),
    sessions: z.array(storedDailySessionSchema).min(1).max(20),
    rejected: z
      .array(
        z
          .object({ day: z.iso.date(), reason: z.string().min(1).max(300) })
          .strict(),
      )
      .max(20),
    summary: z
      .object({
        sessions: z.array(
          z
            .object({
              day: z.iso.date(),
              pnl: finiteNumber,
              drawdown: finiteNumber.nonnegative(),
              totalFees: finiteNumber.nonnegative(),
              trades: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        sessionsRun: z.number().int().positive(),
        winningSessions: z.number().int().nonnegative(),
        losingSessions: z.number().int().nonnegative(),
        breakEvenSessions: z.number().int().nonnegative(),
        totalPnl: finiteNumber,
        totalFees: finiteNumber.nonnegative(),
        worstSessionDrawdown: finiteNumber.nonnegative(),
        averagePnlPerSession: finiteNumber,
      })
      .strict(),
  })
  .strict();
export type StoredDailyCalculation = z.infer<typeof storedDailyResponseSchema>;

export const marketInsightDatasetSchema = z.enum([
  "fii-dii",
  "corporate-actions",
  "corporate-announcements",
  "upcoming-results",
  "active-equities-value",
  "active-index-calls",
  "active-index-puts",
  "active-stock-calls",
  "active-stock-puts",
  "active-derivatives-oi",
  "active-derivatives-volume",
]);
export type MarketInsightDataset = z.infer<typeof marketInsightDatasetSchema>;
const marketInsightResponseSchema = z
  .object({
    dataset: marketInsightDatasetSchema,
    label: z.string().min(1).max(100),
    provider: z.literal("nsefin"),
    observedAt: z.number().int().nonnegative(),
    items: z
      .array(
        z
          .object({
            title: z.string().min(1).max(160),
            subtitle: z.string().max(160).nullable(),
            values: z
              .array(
                z
                  .object({
                    label: z.string().min(1).max(40),
                    value: z.string().min(1).max(160),
                  })
                  .strict(),
              )
              .max(5),
          })
          .strict(),
      )
      .max(12),
    warning: z.string().min(1).max(300),
  })
  .strict();
export type MarketInsightResponse = z.infer<typeof marketInsightResponseSchema>;

/** Treat a response-contract mismatch as service failure without exposing payload details. */
function parseServiceResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = "Calculation service returned invalid data.";
    throw Object.assign(new Error(detail), { status: 503, detail });
  }
  return parsed.data;
}

/** Read one bounded JSON response; an internal service still receives no unlimited trust. */
async function readBoundedJson(response: Response, maximumBytes: number) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximumBytes) {
    throw new Error("Calculation response exceeded its size limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) {
    throw new Error("Calculation response exceeded its size limit");
  }
  if (!response.ok) {
    let detail = "Calculation input was rejected.";
    if (response.status === 422) {
      try {
        const parsed = JSON.parse(text) as { detail?: unknown };
        if (typeof parsed.detail === "string" && parsed.detail.length <= 300) {
          detail = parsed.detail;
        }
      } catch {}
      throw Object.assign(new Error(detail), { status: 422, detail });
    }
    detail = "Calculation service is unavailable.";
    throw Object.assign(new Error(detail), { status: 503, detail });
  }
  return JSON.parse(text) as unknown;
}

/** Construct an allowlisted internal origin; production never uses a public/user URL. */
export class CalculationClient {
  private readonly origin: string;
  private readonly token: string;

  constructor(env: NodeJS.ProcessEnv) {
    const production =
      env.APP_ENV === "production" || env.NODE_ENV === "production";
    const rawOrigin = env.CALCULATION_SERVICE_URL || "http://127.0.0.1:8010";
    const parsed = new URL(rawOrigin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error(
        "CALCULATION_SERVICE_URL must be a private service origin.",
      );
    }
    this.token =
      env.CALCULATION_SERVICE_TOKEN ||
      (production ? "" : "local-development-calculation-token-change-me");
    if (this.token.length < 32) {
      throw new Error(
        "CALCULATION_SERVICE_TOKEN must contain at least 32 characters.",
      );
    }
    this.origin = parsed.origin;
  }

  /** Invoke one authenticated Python operation with cancellation and no automatic retry. */
  private async request(path: string, payload: unknown, signal?: AbortSignal) {
    try {
      const response = await fetch(new URL(path, this.origin), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000),
      });
      return readBoundedJson(response, 12 * 1024 * 1024);
    } catch (cause) {
      if (signal?.aborted || (cause as Error).name === "AbortError") {
        throw cause;
      }
      if ((cause as { status?: number }).status) {
        throw cause;
      }
      const detail = "Calculation service is unavailable.";
      throw Object.assign(new Error(detail), { status: 503, detail });
    }
  }

  /** Calculate a complete daily backtest using validated stored candles. */
  public async dailyBacktest(
    bars: z.infer<typeof dailyBarSchema>[],
    settings: CalculationBacktestSettings,
    signal?: AbortSignal,
  ): Promise<{ engineVersion: string; result: PythonBacktestResult }> {
    const response = await this.request(
      "/v1/backtests/daily",
      {
        bars: z.array(dailyBarSchema).min(60).max(10000).parse(bars),
        settings: calculationBacktestSettingsSchema.parse(settings),
      },
      signal,
    );
    return parseServiceResponse(
      z
        .object({
          engineVersion: z.string().min(1).max(80),
          result: backtestResultSchema,
        })
        .strict(),
      response,
    );
  }

  /** Calculate one complete options payoff/Greeks grid. */
  public async payoff(
    input: PayoffRequest,
    signal?: AbortSignal,
  ): Promise<{ engineVersion: string; result: PythonPayoffResult }> {
    const response = await this.request(
      "/v1/options/payoff",
      payoffRequestSchema.parse(input),
      signal,
    );
    return parseServiceResponse(
      z
        .object({
          engineVersion: z.string().min(1).max(80),
          result: payoffResultSchema,
        })
        .strict(),
      response,
    );
  }

  /** Replay stored daily candles without exposing broker sessions to Python. */
  public async storedDaily(
    strategy: z.infer<typeof storedDailyStrategySchema>,
    bars: z.infer<typeof dailyBarSchema>[],
    signal?: AbortSignal,
  ): Promise<StoredDailyCalculation> {
    const response = await this.request(
      "/v1/research/stored-daily",
      {
        strategy: storedDailyStrategySchema.parse(strategy),
        candles: z.array(dailyBarSchema).min(1).max(20).parse(bars),
      },
      signal,
    );
    return parseServiceResponse(storedDailyResponseSchema, response);
  }

  /** Read one explicitly requested, bounded public NSE reference dataset. */
  public async marketInsights(
    dataset: MarketInsightDataset,
    signal?: AbortSignal,
  ): Promise<MarketInsightResponse> {
    const response = await this.request(
      "/v1/market/insights",
      { dataset: marketInsightDatasetSchema.parse(dataset) },
      signal,
    );
    return parseServiceResponse(marketInsightResponseSchema, response);
  }
}
