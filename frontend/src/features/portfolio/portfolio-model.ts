import { z } from "zod";

export const portfolioProviderSchema = z.enum(["kotak", "zerodha"]);
export type PortfolioProvider = z.infer<typeof portfolioProviderSchema>;

const portfolioRowSchema = z
  .object({
    instrumentToken: z.string().regex(/^\d{1,20}$/),
    symbol: z.string().min(1).max(120),
    exchange: z.string().min(1).max(120),
    product: z.string().max(120),
    quantity: z.number().int().safe(),
    averagePrice: z.number().finite().nullable(),
    markPrice: z.number().finite().nullable(),
    pnl: z.number().finite().nullable(),
    pnlBase: z.number().finite().nullable(),
    pnlPerMark: z.number().finite().nullable(),
    expiry: z.string().max(120),
    right: z.string().max(120),
    strike: z.string().max(120),
  })
  .strict();

const portfolioSectionSchema = z
  .object({
    rows: z.array(portfolioRowSchema).max(9999).nullable(),
    error: z.string().max(300).nullable(),
  })
  .strict();

export const portfolioSnapshotSchema = z
  .object({
    broker: portfolioProviderSchema,
    readOnly: z.literal(true),
    observedAt: z.number().int().nonnegative(),
    positions: portfolioSectionSchema,
    holdings: portfolioSectionSchema,
  })
  .strict();

export const portfolioRegistrySchema = z.object({
  activeBrokerId: z.string().uuid().nullable(),
  brokers: z.array(
    z.object({
      id: z.string().uuid(),
      provider: portfolioProviderSchema,
      status: z.enum(["connected", "disconnected"]),
      connectedAt: z.number().finite(),
      updatedAt: z.number().finite(),
    }),
  ),
});

export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;
export type PortfolioKind = "holdings" | "positions";
export type PortfolioDisplayRow = z.infer<typeof portfolioRowSchema> & {
  providers: PortfolioProvider[];
  investedAmount: number | null;
  currentValue: number | null;
};

/** Club exact instruments without hiding simultaneous long and short exposure. */
export function clubPortfolioRows(
  snapshots: readonly PortfolioSnapshot[],
  kind: PortfolioKind,
): PortfolioDisplayRow[] {
  const groups = new Map<
    string,
    Array<{
      provider: PortfolioProvider;
      row: z.infer<typeof portfolioRowSchema>;
    }>
  >();
  for (const snapshot of snapshots) {
    for (const row of snapshot[kind].rows ?? []) {
      if (row.quantity === 0) {
        continue;
      }
      const side = kind === "positions" && row.quantity < 0 ? "short" : "long";
      const canonicalSymbol =
        kind === "holdings"
          ? row.symbol.replace(/-(?:EQ|BE)$/i, "").toUpperCase()
          : row.symbol.toUpperCase();
      const key = [
        row.exchange,
        canonicalSymbol,
        row.expiry,
        row.right,
        row.strike,
        side,
      ].join("|");
      const group = groups.get(key) ?? [];
      group.push({ provider: snapshot.broker, row });
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group): PortfolioDisplayRow => {
      const first = group[0]!.row;
      const quantity = group.reduce((sum, item) => sum + item.row.quantity, 0);
      const knownAverages = group.every(
        (item) => item.row.averagePrice !== null,
      );
      const knownMarks = group.every((item) => item.row.markPrice !== null);
      const knownPnl = group.every((item) => item.row.pnl !== null);
      const absoluteUnits = group.reduce(
        (sum, item) => sum + Math.abs(item.row.quantity),
        0,
      );
      const investedAmount = knownAverages
        ? group.reduce(
            (sum, item) =>
              sum + Math.abs(item.row.quantity) * item.row.averagePrice!,
            0,
          )
        : null;
      const currentValue = knownMarks
        ? group.reduce(
            (sum, item) => sum + item.row.quantity * item.row.markPrice!,
            0,
          )
        : null;
      return {
        ...first,
        product:
          new Set(group.map((item) => item.row.product)).size === 1
            ? first.product
            : "Multiple",
        quantity,
        averagePrice:
          investedAmount !== null && absoluteUnits
            ? investedAmount / absoluteUnits
            : null,
        markPrice:
          currentValue !== null && quantity ? currentValue / quantity : null,
        pnl: knownPnl
          ? group.reduce((sum, item) => sum + item.row.pnl!, 0)
          : null,
        providers: [...new Set(group.map((item) => item.provider))],
        investedAmount,
        currentValue,
      };
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

/** A portfolio total is unavailable when any contributing row is unknown. */
export function completeTotal(
  rows: readonly PortfolioDisplayRow[],
  field: "investedAmount" | "currentValue" | "pnl",
): number | null {
  if (rows.some((row) => row[field] === null)) {
    return null;
  }
  return rows.reduce((sum, row) => sum + row[field]!, 0);
}
