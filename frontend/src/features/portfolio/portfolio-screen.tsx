"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Field, Select } from "@/components/ui/field";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { requestApiJson } from "@/lib/api";
import {
  portfolioContractLabel,
  portfolioDashboardSchema,
  type PortfolioAccount,
  type PortfolioDashboard,
  type PortfolioItem,
  type PortfolioProvider,
} from "./portfolio-model";
import styles from "./portfolio-screen.module.css";

const providerLabels: Record<PortfolioProvider, string> = {
  kotak: "Kotak Neo",
  zerodha: "Zerodha Kite",
};

const money = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
      }).format(value);

/** Durable portfolio dashboard; broker selection here never changes order routing. */
export function PortfolioScreen({ csrf }: { csrf: string }) {
  const toast = useToast();
  const [dashboard, setDashboard] = useState<PortfolioDashboard | null>(null);
  const [accountOptions, setAccountOptions] = useState<PortfolioAccount[]>([]);
  const [selection, setSelection] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const bootstrapped = useRef(false);

  /** Read a stored view, or explicitly synchronize the selected connected accounts. */
  const loadDashboard = useCallback(
    async (synchronize: boolean, selected = selection) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      try {
        const brokerIds = selected === "all" ? undefined : [selected];
        const value = synchronize
          ? await requestApiJson(
              "/portfolio/sync",
              "POST",
              brokerIds ? { brokerIds } : {},
              csrf,
              95000,
              controller.signal,
            )
          : await requestApiJson(
              `/portfolio/dashboard${brokerIds ? `?brokerId=${encodeURIComponent(selected)}` : ""}`,
              "GET",
              undefined,
              undefined,
              15000,
              controller.signal,
            );
        if (controller.signal.aborted) {
          return;
        }
        const parsed = portfolioDashboardSchema.parse(value);
        setDashboard(parsed);
        if (selected === "all") {
          setAccountOptions(parsed.accounts);
        }
        // Existing connections created before durable portfolios were introduced
        // receive their first snapshot without requiring a legacy Load button.
        if (!synchronize && !parsed.accounts.length && !bootstrapped.current) {
          bootstrapped.current = true;
          await loadDashboard(true, "all");
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Portfolio data is unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [csrf, selection],
  );

  /** Load stored snapshots when the screen or selected account changes. */
  useEffect(() => {
    void loadDashboard(false);
    return () => request.current?.abort();
  }, [loadDashboard]);

  // The dashboard's `synchronization` field is only populated by a /portfolio/sync
  // call (see loadDashboard above); surfacing it here gives the explicit "Refresh
  // broker data" action feedback without altering that fetch logic at all.
  const lastSyncRef = useRef<PortfolioDashboard["synchronization"]>(undefined);
  useEffect(() => {
    const sync = dashboard?.synchronization;
    if (sync && sync !== lastSyncRef.current) {
      if (sync.failures > 0) {
        toast({
          tone: sync.updated > 0 ? "info" : "error",
          title: `Synced ${sync.updated} of ${sync.requested} accounts`,
          description: `${sync.failures} account${sync.failures === 1 ? "" : "s"} failed to sync.`,
        });
      } else if (sync.requested > 0) {
        toast({
          tone: "success",
          title: `Synced ${sync.updated} of ${sync.requested} accounts`,
        });
      }
    }
    lastSyncRef.current = sync;
  }, [dashboard, toast]);

  const holdings = useMemo(
    () => dashboard?.items.filter((item) => item.kind === "holding") ?? [],
    [dashboard],
  );
  const positions = useMemo(
    () => dashboard?.items.filter((item) => item.kind === "position") ?? [],
    [dashboard],
  );
  const warnings = useMemo(
    () => dashboard?.accounts.flatMap((account) => account.warnings) ?? [],
    [dashboard],
  );

  const showEmpty = !loading && !dashboard?.accounts.length && !error;
  const showContent = Boolean(dashboard && dashboard.accounts.length > 0);

  return (
    <section className={styles.screen} aria-label="Portfolio dashboard">
      <header className={styles.header}>
        <div>
          <h1>Portfolio</h1>
          <p>
            Consolidated broker snapshots. Portfolio selection does not change
            the active broker used for live orders.
          </p>
        </div>
        <div className={styles.selector}>
          <Field label="Account" htmlFor="portfolio-account">
            <Select
              id="portfolio-account"
              value={selection}
              disabled={loading || !accountOptions.length}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="all">All portfolios</option>
              {accountOptions.map((account) => (
                <option key={account.brokerId} value={account.brokerId}>
                  {account.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button disabled={loading} onClick={() => void loadDashboard(true)}>
            <RefreshCw size={14} className={loading ? styles.spinning : ""} />
            {loading ? "Synchronizing…" : "Refresh broker data"}
          </Button>
        </div>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error} Values, if shown, are the last successful snapshot.{" "}
          <a href="#/brokers">Open broker connections</a>
        </p>
      )}
      {warnings.map((warning) => (
        <p className={styles.warning} role="status" key={warning}>
          {warning}
        </p>
      ))}

      {loading && !dashboard && <SkeletonRows rows={4} columns={4} />}

      {showEmpty && (
        <EmptyState
          title="No portfolio yet"
          description="Connect a broker to create its portfolio and first snapshot automatically."
          action={
            <a className={styles.emptyLink} href="#/brokers">
              Connect a broker
            </a>
          }
        />
      )}

      {showContent && dashboard && (
        <>
          <div className={styles.coverage}>
            <strong>
              {dashboard.coverage.updatedAccounts} of{" "}
              {dashboard.coverage.totalAccounts} accounts updated
            </strong>
            <span>
              {dashboard.coverage.completeAccounts ===
              dashboard.coverage.totalAccounts
                ? "Complete broker coverage"
                : "Incomplete accounts are excluded from complete totals"}
            </span>
          </div>
          <div className={styles.metrics}>
            <Metric
              label="Account equity"
              value={money(dashboard.summary.totalEquity)}
            />
            <Metric
              label="Holdings value"
              value={money(dashboard.summary.holdingsValue)}
            />
            <Metric
              label="Open-position P&L"
              value={money(dashboard.summary.positionsPnl)}
              tone={dashboard.summary.positionsPnl}
            />
            <Metric
              label="Cash balance"
              value={money(dashboard.summary.cashBalance)}
            />
            <Metric
              label="Available margin"
              value={money(dashboard.summary.availableMargin)}
            />
            <Metric
              label="Pledged holdings"
              value={money(dashboard.summary.pledgedValue)}
            />
            <Metric
              label="Collateral value"
              value={money(dashboard.summary.collateralValue)}
            />
            <Metric
              label="Used margin"
              value={money(dashboard.summary.usedMargin)}
            />
          </div>
          <PerformanceChart dashboard={dashboard} />
          <PortfolioTable title="Holdings" rows={holdings} holdings />
          <PortfolioTable title="Open positions" rows={positions} />
          <p className={styles.disclaimer}>
            Pledged value classifies holdings and is not added again to account
            equity. Available margin is buying power, not cash. Values are
            stored broker snapshots; this screen cannot place or authorize an
            order.
          </p>
        </>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: number | null;
}) {
  return (
    <Card className={styles.metricCard} aria-label={label}>
      <span>{label}</span>
      <strong
        className={
          typeof tone !== "number" ? "" : tone < 0 ? styles.loss : styles.gain
        }
      >
        {value}
      </strong>
    </Card>
  );
}

/** Compact SVG uses only complete daily points; gaps are never interpolated as real values. */
function PerformanceChart({ dashboard }: { dashboard: PortfolioDashboard }) {
  const points = dashboard.history
    .filter((point) => point.totalEquity !== null)
    .map((point) => ({ day: point.day, value: point.totalEquity! }));
  if (points.length < 2) {
    return (
      <Card>
        <CardTitle>Portfolio performance</CardTitle>
        <CardDescription>
          Performance history begins with the first complete daily snapshot.
        </CardDescription>
      </Card>
    );
  }
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const polyline = points
    .map((point, index) => {
      const x = 12 + (index / (points.length - 1)) * 676;
      const y = 148 - ((point.value - min) / span) * 116;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <Card className={styles.chartCard}>
      <CardHeader>
        <div>
          <CardTitle>Portfolio performance</CardTitle>
          <CardDescription>
            Complete daily account equity snapshots
          </CardDescription>
        </div>
        <strong className={styles.chartValue}>
          {money(points.at(-1)!.value)}
        </strong>
      </CardHeader>
      <svg
        viewBox="0 0 700 170"
        role="img"
        aria-label="Portfolio equity history"
      >
        <line x1="12" y1="148" x2="688" y2="148" />
        <polyline points={polyline} />
      </svg>
      <div className={styles.chartAxis}>
        <span>{points[0]!.day}</span>
        <span>{points.at(-1)!.day}</span>
      </div>
    </Card>
  );
}

function PortfolioTable({
  title,
  rows,
  holdings = false,
}: {
  title: string;
  rows: PortfolioItem[];
  holdings?: boolean;
}) {
  const columns = useMemo<DataTableColumn<PortfolioItem>[]>(() => {
    const base: DataTableColumn<PortfolioItem>[] = [
      {
        key: "instrument",
        header: "Instrument",
        sortValue: (row) => portfolioContractLabel(row),
        render: (row) => (
          <details>
            <summary className={styles.instrumentSummary}>
              <strong>{portfolioContractLabel(row)}</strong>
              <small className={styles.instrumentDetail}>
                {row.exchange} {row.product}
                {row.isin ? ` · ${row.isin}` : ""}
              </small>
            </summary>
            <ul className={styles.breakdown}>
              {row.accounts.map((account) => (
                <li key={account.accountId}>
                  {providerLabels[account.provider]} — {account.quantity} units
                  · {money(account.currentValue)}
                </li>
              ))}
            </ul>
          </details>
        ),
      },
      {
        key: "quantity",
        header: "Qty",
        align: "right",
        sortValue: (row) => row.quantity,
        render: (row) => <span className={styles.mono}>{row.quantity}</span>,
      },
    ];
    if (holdings) {
      base.push(
        {
          key: "pledged",
          header: "Pledged",
          align: "right",
          sortValue: (row) => row.pledgedQuantity ?? -1,
          render: (row) => (
            <span className={styles.mono}>
              {row.pledgedQuantity ?? "Unavailable"}
            </span>
          ),
        },
        {
          key: "t1",
          header: "T1",
          align: "right",
          sortValue: (row) => row.t1Quantity ?? -1,
          render: (row) => (
            <span className={styles.mono}>
              {row.t1Quantity ?? "Unavailable"}
            </span>
          ),
        },
        {
          key: "mtf",
          header: "MTF",
          align: "right",
          sortValue: (row) => row.mtfQuantity ?? -1,
          render: (row) => (
            <span className={styles.mono}>
              {row.mtfQuantity ?? "Unavailable"}
            </span>
          ),
        },
      );
    }
    base.push(
      {
        key: "average",
        header: "Average",
        align: "right",
        sortValue: (row) => row.averagePrice ?? -Infinity,
        render: (row) => (
          <span className={styles.mono}>{money(row.averagePrice)}</span>
        ),
      },
      {
        key: "ltp",
        header: "LTP",
        align: "right",
        sortValue: (row) => row.markPrice ?? -Infinity,
        render: (row) => (
          <span className={styles.mono}>{money(row.markPrice)}</span>
        ),
      },
      {
        key: "value",
        header: "Current value",
        align: "right",
        sortValue: (row) => row.currentValue ?? -Infinity,
        render: (row) => (
          <span className={styles.mono}>{money(row.currentValue)}</span>
        ),
      },
      {
        key: "pnl",
        header: "P&L",
        align: "right",
        sortValue: (row) => row.pnl ?? -Infinity,
        render: (row) => (
          <span
            className={`${styles.mono} ${
              typeof row.pnl !== "number"
                ? ""
                : row.pnl < 0
                  ? styles.loss
                  : styles.gain
            }`}
          >
            {money(row.pnl)}
          </span>
        ),
      },
    );
    return base;
  }, [holdings]);

  return (
    <Card aria-label={title}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {rows.length} consolidated instruments
          </CardDescription>
        </div>
      </CardHeader>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.kind}:${row.canonicalKey}`}
        emptyTitle={`No ${title.toLowerCase()}`}
        emptyDescription={`No non-zero ${title.toLowerCase()} in this snapshot.`}
      />
    </Card>
  );
}
