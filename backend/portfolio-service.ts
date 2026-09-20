/**
 * Broker-neutral portfolio persistence, synchronization and consolidation.
 *
 * Provider adapters supply normalized funds, holdings and positions. This module
 * owns durable snapshots and cross-account totals; it never authenticates a broker,
 * stores raw provider payloads or grants live-trading permission.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { Query, Store } from "./database.js";
import type {
  NormalizedFunds,
  PortfolioRow,
} from "./broker-portfolio-normalizer.js";
import {
  brokerProviderSchema,
  type BrokerProvider,
} from "./broker-registry.js";
import { fail, rateLimit } from "./security.js";

/** Provider implementation required by the portfolio service. */
export interface PortfolioBrokerReader {
  provider: BrokerProvider;
  accountBinding: string;
  loadFunds(): Promise<NormalizedFunds>;
  loadHoldings(): Promise<PortfolioRow[]>;
  loadPositions(): Promise<PortfolioRow[]>;
}

export type PortfolioReaderResolver = (
  provider: BrokerProvider,
  userId: string,
  sessionHash: string,
) => PortfolioBrokerReader | null;

type SyncSource = "connection" | "manual" | "daily";
type Section<T> = { rows: T | null; error: string | null };
type AccountRow = {
  id: string;
  broker_id: string;
  provider: BrokerProvider;
  account_binding: string;
  display_label: string;
  currency: string;
};
type SnapshotRow = {
  id: string;
  account_id: string;
  trading_day: string;
  observed_at: number;
  holdings_value: number | null;
  invested_value: number | null;
  pledged_value: number | null;
  positions_pnl: number | null;
  available_margin: number | null;
  cash_balance: number | null;
  used_margin: number | null;
  collateral_value: number | null;
  total_equity: number | null;
  complete: boolean;
  warnings: unknown;
};
type ItemRow = {
  id: string;
  snapshot_id: string;
  account_id: string;
  provider: BrokerProvider;
  kind: "holding" | "position";
  canonical_key: string;
  isin: string;
  instrument_token: string;
  symbol: string;
  underlying: string;
  exchange: string;
  product: string;
  quantity: number;
  pledged_quantity: number | null;
  t1_quantity: number | null;
  mtf_quantity: number | null;
  average_price: number | null;
  mark_price: number | null;
  pnl: number | null;
  expiry: string;
  option_right: string;
  strike: string;
};

const finiteOrNull = (value: number | null) =>
  value !== null && Number.isFinite(value) ? value : null;

/** Use IST's calendar date for daily snapshot replacement and history alignment. */
export function portfolioTradingDay(timestamp: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

/** Cross-provider identity prefers ISIN, then exact derivative terms, then guarded token/symbol. */
export function canonicalPortfolioKey(
  kind: "holding" | "position",
  row: PortfolioRow,
) {
  const side = row.quantity < 0 ? "short" : "long";
  const isin = row.isin.trim().toUpperCase();
  if (kind === "holding" && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) {
    return `equity|isin:${isin}|${side}`;
  }
  const expiry = row.expiry.trim().toUpperCase();
  const right = row.right.trim().toUpperCase();
  const strike = row.strike.trim().toUpperCase();
  if (expiry && right && strike) {
    const underlying = (row.underlying || row.symbol)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return `derivative|${row.exchange}|${underlying}|${expiry}|${strike}|${right}|${row.product}|${side}`;
  }
  const symbol = row.symbol
    .replace(/-(?:EQ|BE)$/i, "")
    .trim()
    .toUpperCase();
  const identity = row.instrumentToken
    ? `token:${row.instrumentToken}`
    : `symbol:${symbol}`;
  return `${kind}|${row.exchange}|${identity}|${row.product}|${side}`;
}

/** Return null rather than publishing a total assembled from partially unknown values. */
function completeSum(values: Array<number | null>) {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}

/** Compute one account's summary without double-counting pledged value or available margin. */
export function calculatePortfolioSummary(
  funds: NormalizedFunds | null,
  holdings: PortfolioRow[] | null,
  positions: PortfolioRow[] | null,
) {
  const holdingValues =
    holdings?.map((row) =>
      row.markPrice === null ? null : row.quantity * row.markPrice,
    ) ?? null;
  const investedValues =
    holdings?.map((row) =>
      row.averagePrice === null ? null : row.quantity * row.averagePrice,
    ) ?? null;
  const pledgedValues =
    holdings?.map((row) =>
      row.pledgedQuantity === null || row.markPrice === null
        ? null
        : row.pledgedQuantity * row.markPrice,
    ) ?? null;
  const holdingsValue = holdingValues ? completeSum(holdingValues) : null;
  const investedValue = investedValues ? completeSum(investedValues) : null;
  const pledgedValue = pledgedValues ? completeSum(pledgedValues) : null;
  const itemPositionsPnl = positions
    ? completeSum(positions.map((row) => row.pnl))
    : null;
  const positionsPnl =
    itemPositionsPnl ?? finiteOrNull(funds?.positionMtm ?? null);
  // Available margin is buying power and collateral is already represented by holdings.
  const totalEquity =
    holdingsValue !== null &&
    funds?.cashBalance !== null &&
    funds?.cashBalance !== undefined &&
    positionsPnl !== null
      ? holdingsValue + funds.cashBalance + positionsPnl
      : null;
  return {
    holdingsValue,
    investedValue,
    pledgedValue,
    positionsPnl,
    availableMargin: finiteOrNull(funds?.availableMargin ?? null),
    cashBalance: finiteOrNull(funds?.cashBalance ?? null),
    usedMargin: finiteOrNull(funds?.usedMargin ?? null),
    collateralValue: finiteOrNull(funds?.collateralValue ?? null),
    totalEquity,
  };
}

/** Normalize rejected provider reads into safe, non-sensitive user messages. */
function settledSection<T>(
  result: PromiseSettledResult<T>,
  label: string,
): Section<T> {
  return result.status === "fulfilled"
    ? { rows: result.value, error: null }
    : {
        rows: null,
        error: `${label} unavailable; the account is not assumed empty.`,
      };
}

/** Durable service shared by connection callbacks, manual refresh and daily capture. */
export class PortfolioService {
  constructor(private readonly store: Store) {}

  /** Ensure the irreversible broker binding owns exactly one portfolio account. */
  public async ensureAccount(
    userId: string,
    brokerId: string,
    provider: BrokerProvider,
    accountBinding: string,
  ) {
    return this.store.transaction(async (query) => {
      const baseLabel = provider === "kotak" ? "Kotak Neo" : "Zerodha Kite";
      const [count] = await query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM portfolio_accounts WHERE user_id=$1 AND provider=$2",
        [userId, provider],
      );
      const ordinal = Number(count?.total ?? 0) + 1;
      const label = ordinal === 1 ? baseLabel : `${baseLabel} ${ordinal}`;
      const [row] = await query<AccountRow>(
        `INSERT INTO portfolio_accounts(id,user_id,broker_id,provider,account_binding,display_label,currency)
         VALUES($1,$2,$3,$4,$5,$6,'INR')
         ON CONFLICT(broker_id) DO UPDATE SET account_binding=EXCLUDED.account_binding,provider=EXCLUDED.provider,updated_at=NOW()
         RETURNING id,broker_id,provider,account_binding,display_label,currency`,
        [randomUUID(), userId, brokerId, provider, accountBinding, label],
      );
      return row;
    });
  }

  /** Fetch every section independently, record partial failures and replace today's snapshot atomically. */
  public async syncRegisteredBroker(args: {
    userId: string;
    brokerId: string;
    reader: PortfolioBrokerReader;
    source: SyncSource;
  }) {
    const account = await this.ensureAccount(
      args.userId,
      args.brokerId,
      args.reader.provider,
      args.reader.accountBinding,
    );
    const runId = randomUUID();
    await this.store.transaction((query) =>
      query(
        "INSERT INTO portfolio_sync_runs(id,account_id,source,status,started_at) VALUES($1,$2,$3,'running',NOW())",
        [runId, account.id, args.source],
      ),
    );
    const results = await Promise.allSettled([
      args.reader.loadFunds(),
      args.reader.loadHoldings(),
      args.reader.loadPositions(),
    ] as const);
    const funds = settledSection(results[0], "Funds");
    const holdings = settledSection(results[1], "Holdings");
    const positions = settledSection(results[2], "Positions");
    const warnings = [funds.error, holdings.error, positions.error].filter(
      (value): value is string => Boolean(value),
    );
    if (warnings.length === 3) {
      await this.store.transaction((query) =>
        query(
          "UPDATE portfolio_sync_runs SET status='failed',completed_at=NOW(),error=$2 WHERE id=$1",
          [runId, "All broker portfolio sections were unavailable."],
        ),
      );
      throw new Error("Broker portfolio synchronization failed.");
    }
    const observedAt = Date.now();
    const returnedHoldings =
      holdings.rows?.filter((row) => row.quantity !== 0) ?? null;
    const invalidHoldingBook = Boolean(
      returnedHoldings?.some((row) => row.expiry.trim() !== ""),
    );
    if (invalidHoldingBook) {
      warnings.push(
        "Holdings unavailable; the broker response contained derivative contracts and was not treated as a demat book.",
      );
    }
    const nonZeroHoldings = invalidHoldingBook ? null : returnedHoldings;
    const nonZeroPositions =
      positions.rows?.filter((row) => row.quantity !== 0) ?? null;
    const summary = calculatePortfolioSummary(
      funds.rows,
      nonZeroHoldings,
      nonZeroPositions,
    );
    const snapshotId = await this.store.transaction(async (query) => {
      const [snapshot] = await query<{ id: string }>(
        `INSERT INTO portfolio_snapshots(
           id,account_id,sync_run_id,trading_day,observed_at,holdings_value,invested_value,
           pledged_value,positions_pnl,available_margin,cash_balance,used_margin,
           collateral_value,total_equity,complete,warnings)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT(account_id,trading_day) DO UPDATE SET
           sync_run_id=EXCLUDED.sync_run_id,observed_at=EXCLUDED.observed_at,
           holdings_value=EXCLUDED.holdings_value,invested_value=EXCLUDED.invested_value,
           pledged_value=EXCLUDED.pledged_value,positions_pnl=EXCLUDED.positions_pnl,
           available_margin=EXCLUDED.available_margin,cash_balance=EXCLUDED.cash_balance,
           used_margin=EXCLUDED.used_margin,collateral_value=EXCLUDED.collateral_value,
           total_equity=EXCLUDED.total_equity,complete=EXCLUDED.complete,warnings=EXCLUDED.warnings
         RETURNING id`,
        [
          randomUUID(),
          account.id,
          runId,
          portfolioTradingDay(observedAt),
          observedAt,
          summary.holdingsValue,
          summary.investedValue,
          summary.pledgedValue,
          summary.positionsPnl,
          summary.availableMargin,
          summary.cashBalance,
          summary.usedMargin,
          summary.collateralValue,
          summary.totalEquity,
          warnings.length === 0,
          JSON.stringify(warnings),
        ],
      );
      await query("DELETE FROM portfolio_snapshot_items WHERE snapshot_id=$1", [
        snapshot.id,
      ]);
      for (const [kind, rows] of [
        ["holding", nonZeroHoldings],
        ["position", nonZeroPositions],
      ] as const) {
        for (const row of rows ?? []) {
          await this.insertItem(query, snapshot.id, kind, row);
        }
      }
      await query(
        "UPDATE portfolio_sync_runs SET status=$2,completed_at=NOW(),error=$3 WHERE id=$1",
        [
          runId,
          warnings.length ? "partial" : "completed",
          warnings.length ? warnings.join(" ") : "",
        ],
      );
      return snapshot.id;
    });
    return { accountId: account.id, snapshotId, warnings };
  }

  /** Store only normalized display fields; provider payloads and credentials never enter history. */
  private async insertItem(
    query: Query,
    snapshotId: string,
    kind: "holding" | "position",
    row: PortfolioRow,
  ) {
    await query(
      `INSERT INTO portfolio_snapshot_items(
        id,snapshot_id,kind,canonical_key,isin,instrument_token,symbol,underlying,
        exchange,product,quantity,pledged_quantity,t1_quantity,mtf_quantity,
        average_price,mark_price,pnl,expiry,option_right,strike)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        randomUUID(),
        snapshotId,
        kind,
        canonicalPortfolioKey(kind, row),
        row.isin,
        row.instrumentToken,
        row.symbol,
        row.underlying,
        row.exchange,
        row.product,
        row.quantity,
        row.pledgedQuantity,
        row.t1Quantity,
        row.mtfQuantity,
        row.averagePrice,
        row.markPrice,
        row.pnl,
        row.expiry,
        row.right,
        row.strike,
      ],
    );
  }

  /** Return latest account snapshots and server-clubbed rows for one authenticated owner. */
  public async dashboard(userId: string, brokerIds?: string[]) {
    return this.store.transaction(async (query) => {
      const accounts = await query<AccountRow>(
        `SELECT pa.id,pa.broker_id,pa.provider,pa.account_binding,pa.display_label,pa.currency
         FROM portfolio_accounts pa JOIN user_brokers ub ON ub.id=pa.broker_id
         WHERE pa.user_id=$1 ${brokerIds?.length ? `AND pa.broker_id IN (${brokerIds.map((_, index) => `$${index + 2}`).join(",")})` : ""}
         ORDER BY pa.created_at,pa.id`,
        [userId, ...(brokerIds ?? [])],
      );
      const snapshots: Array<
        SnapshotRow & { provider: BrokerProvider; display_label: string }
      > = [];
      const items: ItemRow[] = [];
      for (const account of accounts) {
        const [snapshot] = await query<SnapshotRow>(
          "SELECT * FROM portfolio_snapshots WHERE account_id=$1 ORDER BY observed_at DESC LIMIT 1",
          [account.id],
        );
        if (!snapshot) {
          continue;
        }
        snapshots.push({
          ...snapshot,
          provider: account.provider,
          display_label: account.display_label,
        });
        const rows = await query<Omit<ItemRow, "account_id" | "provider">>(
          `SELECT id,snapshot_id,kind,canonical_key,isin,instrument_token,symbol,underlying,
                  exchange,product,quantity::DOUBLE PRECISION AS quantity,
                  pledged_quantity::DOUBLE PRECISION AS pledged_quantity,
                  t1_quantity::DOUBLE PRECISION AS t1_quantity,
                  mtf_quantity::DOUBLE PRECISION AS mtf_quantity,
                  average_price,mark_price,pnl,expiry,option_right,strike
           FROM portfolio_snapshot_items WHERE snapshot_id=$1 ORDER BY symbol,canonical_key`,
          [snapshot.id],
        );
        items.push(
          ...rows.map((row) => ({
            ...row,
            account_id: account.id,
            provider: account.provider,
          })),
        );
      }
      const history = await query<SnapshotRow & { provider: BrokerProvider }>(
        `SELECT ps.id,ps.account_id,TO_CHAR(ps.trading_day,'YYYY-MM-DD') AS trading_day,
                ps.observed_at,ps.holdings_value,ps.invested_value,ps.pledged_value,
                ps.positions_pnl,ps.available_margin,ps.cash_balance,ps.used_margin,
                ps.collateral_value,ps.total_equity,ps.complete,ps.warnings,pa.provider
         FROM portfolio_snapshots ps
         JOIN portfolio_accounts pa ON pa.id=ps.account_id
         WHERE pa.user_id=$1 ${brokerIds?.length ? `AND pa.broker_id IN (${brokerIds.map((_, index) => `$${index + 2}`).join(",")})` : ""}
         ORDER BY ps.trading_day,ps.account_id`,
        [userId, ...(brokerIds ?? [])],
      );
      return buildDashboard(accounts, snapshots, items, history);
    });
  }
}

/** Pure consolidation keeps provider fetches and presentation out of the database layer. */
export function buildDashboard(
  accounts: AccountRow[],
  snapshots: Array<
    SnapshotRow & { provider: BrokerProvider; display_label: string }
  >,
  items: ItemRow[],
  history: Array<SnapshotRow & { provider: BrokerProvider }>,
) {
  const grouped = new Map<string, ItemRow[]>();
  for (const item of items) {
    // Legacy snapshots may have a shared underlying token and no call/put identity.
    // Keep those durable rows separate even before the next broker sync; never
    // net short and long holdings or combine provider-specific fallback tokens.
    const derivative =
      /(?:_fo|Options|Futures)/i.test(`${item.exchange} ${item.product}`) ||
      Boolean(item.expiry || item.strike || item.option_right);
    const incomplete =
      derivative && !(item.expiry && item.strike && item.option_right);
    const scope = incomplete
      ? `row:${item.id}`
      : item.canonical_key.includes("token:")
        ? item.provider
        : "";
    const key = `${item.kind}|${item.canonical_key}|${scope}|${item.quantity < 0 ? "short" : "long"}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const consolidatedItems = [...grouped.entries()].map(([key, group]) => {
    const first = group[0]!;
    const quantity = group.reduce((sum, row) => sum + row.quantity, 0);
    const absoluteQuantity = group.reduce(
      (sum, row) => sum + Math.abs(row.quantity),
      0,
    );
    const invested = completeSum(
      group.map((row) =>
        row.average_price === null
          ? null
          : Math.abs(row.quantity) * row.average_price,
      ),
    );
    const current = completeSum(
      group.map((row) =>
        row.mark_price === null ? null : row.quantity * row.mark_price,
      ),
    );
    return {
      kind: first.kind,
      canonicalKey: key,
      isin: first.isin,
      symbol: first.symbol,
      underlying: first.underlying,
      exchange: first.exchange,
      product: first.product,
      expiry: first.expiry,
      right: first.option_right,
      strike: first.strike,
      quantity,
      pledgedQuantity: completeSum(group.map((row) => row.pledged_quantity)),
      t1Quantity: completeSum(group.map((row) => row.t1_quantity)),
      mtfQuantity: completeSum(group.map((row) => row.mtf_quantity)),
      averagePrice:
        invested !== null && absoluteQuantity
          ? invested / absoluteQuantity
          : null,
      markPrice: current !== null && quantity ? current / quantity : null,
      investedAmount: invested,
      currentValue: current,
      pnl: completeSum(group.map((row) => row.pnl)),
      accounts: group.map((row) => ({
        accountId: row.account_id,
        provider: row.provider,
        quantity: row.quantity,
        pledgedQuantity: row.pledged_quantity,
        currentValue:
          row.mark_price === null ? null : row.quantity * row.mark_price,
      })),
    };
  });
  const latestByAccount = new Map(
    snapshots.map((snapshot) => [snapshot.account_id, snapshot]),
  );
  const selected = accounts.map(
    (account) => latestByAccount.get(account.id) ?? null,
  );
  const total = (field: keyof SnapshotRow) =>
    completeSum(
      selected.map((snapshot) => {
        const value = snapshot?.[field];
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : null;
      }),
    );
  const days = new Map<string, Map<string, SnapshotRow>>();
  for (const snapshot of history) {
    const day = String(snapshot.trading_day).slice(0, 10);
    const entries = days.get(day) ?? new Map<string, SnapshotRow>();
    entries.set(snapshot.account_id, snapshot);
    days.set(day, entries);
  }
  return {
    readOnly: true,
    accounts: accounts.map((account) => {
      const snapshot = latestByAccount.get(account.id);
      return {
        id: account.id,
        brokerId: account.broker_id,
        provider: account.provider,
        label: account.display_label,
        currency: account.currency,
        observedAt: snapshot?.observed_at ?? null,
        complete: snapshot?.complete ?? false,
        warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
      };
    }),
    coverage: {
      updatedAccounts: snapshots.length,
      totalAccounts: accounts.length,
      completeAccounts: snapshots.filter((snapshot) => snapshot.complete)
        .length,
    },
    summary: {
      holdingsValue: total("holdings_value"),
      investedValue: total("invested_value"),
      pledgedValue: total("pledged_value"),
      positionsPnl: total("positions_pnl"),
      availableMargin: total("available_margin"),
      cashBalance: total("cash_balance"),
      usedMargin: total("used_margin"),
      collateralValue: total("collateral_value"),
      totalEquity: total("total_equity"),
    },
    items: consolidatedItems.sort((left, right) =>
      left.symbol.localeCompare(right.symbol),
    ),
    history: [...days.entries()].map(([day, values]) => ({
      day,
      updatedAccounts: values.size,
      totalAccounts: accounts.length,
      holdingsValue: completeSum(
        accounts.map(
          (account) => values.get(account.id)?.holdings_value ?? null,
        ),
      ),
      totalEquity: completeSum(
        accounts.map((account) => values.get(account.id)?.total_equity ?? null),
      ),
    })),
  };
}

/** Mount read and explicit sync routes; no route can arm or submit a live order. */
export function registerPortfolioRoutes(
  app: Express,
  store: Store,
  service: PortfolioService,
  resolveReader: PortfolioReaderResolver,
) {
  const limit = rateLimit(12, 60000, (req) => req.res!.locals.session.user_id);
  app.get("/api/portfolio/dashboard", limit, async (req, res) => {
    const ids = z
      .array(z.string().uuid())
      .max(20)
      .parse(
        typeof req.query.brokerId === "string" ? [req.query.brokerId] : [],
      );
    res.json(
      await service.dashboard(
        res.locals.session.user_id,
        ids.length ? ids : undefined,
      ),
    );
  });
  app.post("/api/portfolio/sync", limit, async (req, res) => {
    const input = z
      .object({ brokerIds: z.array(z.string().uuid()).max(20).optional() })
      .strict()
      .parse(req.body ?? {});
    const session = res.locals.session;
    const brokers = await store.transaction((query) =>
      query<{
        id: string;
        provider: BrokerProvider;
        account_binding: string;
      }>(
        `SELECT id,provider,account_binding FROM user_brokers
         WHERE user_id=$1 AND status='connected' ${input.brokerIds?.length ? `AND id IN (${input.brokerIds.map((_, index) => `$${index + 2}`).join(",")})` : ""}
         ORDER BY provider,id`,
        [session.user_id, ...(input.brokerIds ?? [])],
      ),
    );
    if (!brokers.length) {
      fail(409, "Connect a broker before synchronizing a portfolio.");
    }
    const results = await Promise.allSettled(
      brokers.map(async (broker) => {
        const provider = brokerProviderSchema.parse(broker.provider);
        const reader = resolveReader(
          provider,
          session.user_id,
          session.token_hash,
        );
        if (!reader || reader.accountBinding !== broker.account_binding) {
          throw new Error("Reconnect this broker before synchronization.");
        }
        return service.syncRegisteredBroker({
          userId: session.user_id,
          brokerId: broker.id,
          reader,
          source: "manual",
        });
      }),
    );
    const failures = results.filter((result) => result.status === "rejected");
    const dashboard = await service.dashboard(session.user_id, input.brokerIds);
    res.json({
      ...dashboard,
      synchronization: {
        updated: results.length - failures.length,
        requested: results.length,
        failures: failures.length,
      },
    });
  });
}
