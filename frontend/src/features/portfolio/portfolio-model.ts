import { z } from "zod";

export const portfolioProviderSchema = z.enum(["kotak", "zerodha", "icici"]);
export type PortfolioProvider = z.infer<typeof portfolioProviderSchema>;

const nullableMoney = z.number().finite().nullable();
/** Subtotals remain explicitly distinct from complete all-account totals. */
const metricCoverageSchema = z
  .object({
    knownValue: nullableMoney,
    availableAccounts: z.number().int().nonnegative(),
    missingAccountIds: z.array(z.string().uuid()).max(20),
  })
  .strict();

const portfolioAccountSchema = z
  .object({
    id: z.string().uuid(),
    brokerId: z.string().uuid(),
    provider: portfolioProviderSchema,
    label: z.string().min(1).max(80),
    currency: z.literal("INR"),
    observedAt: z.number().finite().nonnegative().nullable(),
    complete: z.boolean(),
    warnings: z.array(z.string().max(300)).max(3),
  })
  .strict();

const accountBreakdownSchema = z
  .object({
    accountId: z.string().uuid(),
    provider: portfolioProviderSchema,
    quantity: z.number().int().safe(),
    pledgedQuantity: z.number().int().safe().nullable(),
    currentValue: nullableMoney,
  })
  .strict();

const portfolioItemSchema = z
  .object({
    kind: z.enum(["holding", "position"]),
    canonicalKey: z.string().min(1).max(500),
    isin: z.string().max(32),
    symbol: z.string().min(1).max(120),
    underlying: z.string().max(120),
    exchange: z.string().max(40),
    product: z.string().max(40),
    expiry: z.string().max(40),
    right: z.string().max(20),
    strike: z.string().max(40),
    quantity: z.number().int().safe(),
    pledgedQuantity: z.number().int().safe().nullable(),
    t1Quantity: z.number().int().safe().nullable(),
    mtfQuantity: z.number().int().safe().nullable(),
    averagePrice: nullableMoney,
    markPrice: nullableMoney,
    lastCloseDays: z.array(z.iso.date()).default([]),
    estimatedPnl: z.boolean().default(false),
    investedAmount: nullableMoney,
    currentValue: nullableMoney,
    pnl: nullableMoney,
    accounts: z.array(accountBreakdownSchema).max(20),
  })
  .strict();

export const portfolioDashboardSchema = z
  .object({
    readOnly: z.literal(true),
    accounts: z.array(portfolioAccountSchema).max(20),
    coverage: z
      .object({
        updatedAccounts: z.number().int().nonnegative(),
        totalAccounts: z.number().int().nonnegative(),
        completeAccounts: z.number().int().nonnegative(),
      })
      .strict(),
    summary: z
      .object({
        holdingsValue: nullableMoney,
        investedValue: nullableMoney,
        pledgedValue: nullableMoney,
        positionsPnl: nullableMoney,
        availableMargin: nullableMoney,
        cashBalance: nullableMoney,
        usedMargin: nullableMoney,
        collateralValue: nullableMoney,
        totalEquity: nullableMoney,
      })
      .strict(),
    items: z.array(portfolioItemSchema).max(20_000),
    summaryCoverage: z
      .object({
        holdingsValue: metricCoverageSchema,
        investedValue: metricCoverageSchema,
        pledgedValue: metricCoverageSchema,
        positionsPnl: metricCoverageSchema,
        availableMargin: metricCoverageSchema,
        cashBalance: metricCoverageSchema,
        usedMargin: metricCoverageSchema,
        collateralValue: metricCoverageSchema,
        totalEquity: metricCoverageSchema,
      })
      .strict()
      .optional(),
    history: z.array(
      z
        .object({
          day: z.iso.date(),
          updatedAccounts: z.number().int().nonnegative(),
          totalAccounts: z.number().int().nonnegative(),
          holdingsValue: nullableMoney,
          totalEquity: nullableMoney,
        })
        .strict(),
    ),
    synchronization: z
      .object({
        updated: z.number().int().nonnegative(),
        requested: z.number().int().nonnegative(),
        failures: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PortfolioDashboard = z.infer<typeof portfolioDashboardSchema>;
export type PortfolioAccount = PortfolioDashboard["accounts"][number];
export type PortfolioItem = PortfolioDashboard["items"][number];

/** Keep derivative contract terms visible when a broker symbol is abbreviated. */
export function portfolioContractLabel(item: {
  symbol: string;
  expiry?: string;
  strike?: string;
  right?: string;
  product?: string;
}) {
  const right =
    item.right ||
    (/option/i.test(item.product ?? "") ? "option type unavailable" : "");
  return [item.symbol, item.expiry, item.strike, right]
    .filter(Boolean)
    .join(" · ");
}
