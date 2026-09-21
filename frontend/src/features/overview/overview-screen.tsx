"use client";
import { useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  Clock3,
  LockKeyhole,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { brokerAccountAdapters } from "@/features/overview/providers/broker-account-adapters";
import { useBrokerRegistry } from "@/features/brokers/broker-hooks";
import {
  formatAccountMoney,
  formatActivityTime,
  combineConnectedPositions,
  combineConnectedBalances,
  type BrokerHolding,
  type BrokerPosition,
  type OverviewDestination,
  type OverviewWorkspace,
} from "@/features/overview/account-model";
import { useOverviewAccount } from "@/features/overview/use-overview-account";
import { NseMarketIntelligence } from "@/features/overview/nse-market-intelligence";
import { orderAuditEvents } from "@/features/activity/audit-model";
import styles from "@/features/overview/overview-screen.module.css";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog, DialogDescription } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/** Unknown valuations receive no profit/loss color. Module-scope: pure, no component state. */
function getPnlClassName(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? ""
    : value < 0
      ? styles.negative
      : styles.positive;
}

/** Overview is a read-only orientation screen. Every action either loads account data
 * or navigates to a dedicated workflow; no broker execution permissions are changed here. */
export function OverviewScreen({
  workspace,
  onNavigate,
  onExploreOptionChain,
}: {
  workspace: OverviewWorkspace;
  onNavigate: (destination: OverviewDestination) => void;
  onExploreOptionChain: () => void;
}) {
  const toast = useToast();
  const registry = useBrokerRegistry(workspace.csrf);
  const connectedBrokers = useMemo(() => {
    const connectedProviders = new Set(
      registry.brokers
        .filter((item) => item.status === "connected")
        .map((item) => item.provider),
    );
    return brokerAccountAdapters.filter((adapter) =>
      connectedProviders.has(adapter.id as "kotak" | "zerodha" | "icici"),
    );
  }, [registry.brokers]);
  const [showPositions, setShowPositions] = useState(false);
  const [showHoldings, setShowHoldings] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<
    OverviewWorkspace["events"][number] | null
  >(null);
  const [activityDialogOpen, setActivityDialogOpen] = useState(false);
  // Fixed hook order: each provider owns its snapshot/feed; MFA is read once per app session.
  const security = useOverviewAccount(null, workspace.csrf);
  const kotak = useOverviewAccount(
    connectedBrokers.find((item) => item.id === "kotak") ?? null,
    workspace.csrf,
    false,
  );
  const zerodha = useOverviewAccount(
    connectedBrokers.find((item) => item.id === "zerodha") ?? null,
    workspace.csrf,
    false,
  );
  const icici = useOverviewAccount(
    connectedBrokers.find((item) => item.id === "icici") ?? null,
    workspace.csrf,
    false,
  );
  const accounts = { kotak, zerodha, icici };
  const account = security;
  const books = connectedBrokers.map((adapter) => ({
    ...adapter,
    account: accounts[adapter.id as keyof typeof accounts],
  }));
  const combined = combineConnectedPositions(
    books.map(({ id, name, account: book }) => ({
      id,
      name,
      snapshot: book.live,
      current: book.positionsCurrent,
    })),
  );
  const positionsLoading = books.some((book) => book.account.loading);
  const balances = combineConnectedBalances(
    books.map(({ id, name, account: book }) => ({
      id,
      name,
      snapshot: book.live,
      current: book.connected === true && !book.loading && !book.error,
      holdingsCurrent: book.holdingsCurrent,
    })),
  );
  const connectedCount = books.filter(
    (book) => book.account.connected === true,
  ).length;
  const recentEvents = orderAuditEvents(workspace.events).slice(0, 5);
  const positionColumns = useMemo<DataTableColumn<BrokerPosition>[]>(
    () => [
      {
        key: "broker",
        header: "Broker",
        render: (position) => position.brokerName,
        sortValue: (position) => position.brokerName,
      },
      {
        key: "symbol",
        header: "Instrument",
        render: (position) => position.symbol,
        sortValue: (position) => position.symbol,
      },
      {
        key: "quantity",
        header: "Units",
        align: "right",
        render: (position) => (
          <span className={styles.numeric}>{position.quantity}</span>
        ),
        sortValue: (position) => position.quantity,
      },
      {
        key: "average",
        header: "Average",
        align: "right",
        render: (position) => (
          <span className={styles.numeric}>
            {formatAccountMoney(position.averagePrice)}
          </span>
        ),
        sortValue: (position) => position.averagePrice ?? -Infinity,
      },
      {
        key: "mark",
        header: "Mark",
        align: "right",
        render: (position) => (
          <span className={styles.numeric}>
            {formatAccountMoney(position.markPrice)}
          </span>
        ),
        sortValue: (position) => position.markPrice ?? -Infinity,
      },
      {
        key: "pnl",
        header: "Position P&L",
        align: "right",
        render: (position) => (
          <span
            className={`${styles.numeric} ${getPnlClassName(position.pnl)}`}
          >
            {formatAccountMoney(position.pnl)}
          </span>
        ),
        sortValue: (position) => position.pnl ?? -Infinity,
      },
    ],
    [],
  );
  const holdingColumns = useMemo<DataTableColumn<BrokerHolding>[]>(
    () => [
      {
        key: "broker",
        header: "Broker",
        render: (holding) => holding.brokerName,
        sortValue: (holding) => holding.brokerName,
      },
      {
        key: "symbol",
        header: "Instrument",
        render: (holding) => (
          <>
            {holding.symbol}
            <small className={styles.instrumentMeta}>
              {holding.exchange} {holding.product}
            </small>
          </>
        ),
        sortValue: (holding) => holding.symbol,
      },
      {
        key: "quantity",
        header: "Total units",
        align: "right",
        render: (holding) => (
          <span className={styles.numeric}>
            {holding.quantity.toLocaleString("en-IN")}
          </span>
        ),
        sortValue: (holding) => holding.quantity,
      },
      {
        key: "pledged",
        header: "Pledged",
        align: "right",
        render: (holding) => (
          <span className={styles.numeric}>
            {holding.pledgedQuantity?.toLocaleString("en-IN") ?? "—"}
          </span>
        ),
        sortValue: (holding) => holding.pledgedQuantity ?? -Infinity,
      },
      {
        key: "t1",
        header: "T1 / unsettled",
        align: "right",
        render: (holding) => (
          <span className={styles.numeric}>
            {holding.t1Quantity?.toLocaleString("en-IN") ?? "—"}
          </span>
        ),
        sortValue: (holding) => holding.t1Quantity ?? -Infinity,
      },
      {
        key: "average",
        header: "Average",
        align: "right",
        render: (holding) => (
          <span className={styles.numeric}>
            {formatAccountMoney(holding.averagePrice)}
          </span>
        ),
        sortValue: (holding) => holding.averagePrice ?? -Infinity,
      },
      {
        key: "ltp",
        header: "LTP",
        align: "right",
        render: (holding) => (
          <span className={styles.numeric}>
            {formatAccountMoney(holding.markPrice)}
          </span>
        ),
        sortValue: (holding) => holding.markPrice ?? -Infinity,
      },
      {
        key: "currentValue",
        header: "Current value",
        align: "right",
        render: (holding) => (
          <span className={styles.numeric}>
            {formatAccountMoney(
              holding.markPrice === null
                ? null
                : holding.quantity * holding.markPrice,
            )}
          </span>
        ),
        sortValue: (holding) =>
          holding.markPrice === null
            ? -Infinity
            : holding.quantity * holding.markPrice,
      },
      {
        key: "pnl",
        header: "Holding P&L",
        align: "right",
        render: (holding) => (
          <span className={`${styles.numeric} ${getPnlClassName(holding.pnl)}`}>
            {formatAccountMoney(holding.pnl)}
          </span>
        ),
        sortValue: (holding) => holding.pnl ?? -Infinity,
      },
    ],
    [],
  );
  /** Bind a navigation destination without granting any trading permissions. */
  const onNavigateTo = (destination: OverviewDestination) => {
    /** Forward the user's click to the workspace shell. */
    return () => onNavigate(destination);
  };

  /** Explicitly refresh every connected account; hooks isolate failures and loading state.
   * Surfaces the outcome as a toast — the hook's own request/error handling is unchanged. */
  async function onRefreshSnapshot() {
    const results = await Promise.all(
      books.map((book) => book.account.loadAccountSnapshot()),
    );
    const errors = results.filter(
      (result): result is string => typeof result === "string",
    );
    if (results.length && results.every((result) => result === true)) {
      toast({
        tone: "success",
        title: "Snapshot refreshed",
        description:
          "Connected broker reads completed. Review any partial-data warnings below.",
      });
    } else if (errors.length) {
      toast({
        tone: "error",
        title: "Some accounts could not refresh",
        description: errors.join(" "),
      });
    }
  }
  /** Expand/collapse the consolidated position table without refetching reports. */
  function onTogglePositions() {
    setShowPositions(!showPositions);
  }
  /** Expand/collapse demat holdings without triggering another broker request. */
  function onToggleHoldings() {
    setShowHoldings(!showHoldings);
  }
  /** Bind the chosen audit event to the controlled details dialog. */
  function onOpenActivity(event: OverviewWorkspace["events"][number]) {
    /** Open the dialog on user intent. */
    return () => {
      setSelectedEvent(event);
      setActivityDialogOpen(true);
    };
  }
  /** Clear details after the dialog is dismissed, by any path. */
  function onActivityClosed() {
    setActivityDialogOpen(false);
    setSelectedEvent(null);
  }

  return (
    <section
      id="overview-screen"
      className={styles.screen}
      aria-label="Trading workspace overview"
    >
      {/* Overview never selects an execution account; every connected provider is included. */}
      <header className={styles.heading}>
        <div>
          <h1>Your trading workspace</h1>
          <p>Know what needs attention, then get back to your work.</p>
        </div>
        <p>
          All connected brokers ·{" "}
          {registry.loading ? "Loading…" : `${books.length} accounts`}
        </p>
      </header>

      {/* Readiness is informative only; this screen cannot arm or submit orders. */}
      <section className={styles.banner} aria-label="Live trading readiness">
        <div>
          <strong>
            <LockKeyhole size={15} />
            {workspace.live_configured
              ? "Live execution requires explicit authorization"
              : "Live trading is disabled by server configuration"}
          </strong>
          <p>
            {workspace.live_configured
              ? "Review your risk limits and arm live trading in its dedicated screen. Viewing this dashboard never enables orders."
              : "Research and account viewing remain available. The server operator must enable live execution before you can authorize trading; MFA or connecting a broker alone will not unlock it."}
          </p>
        </div>
        <Button
          variant="secondary"
          className={styles.readinessAction}
          onClick={onNavigateTo("Live trading")}
        >
          {workspace.live_configured
            ? "Review live controls"
            : "View execution requirements"}{" "}
          <ArrowRight size={14} />
        </Button>
      </section>

      {/* Complete totals require every included account; unavailable values are never zero. */}
      <div className={styles.metrics}>
        <article className={styles.metric} aria-label="Available account funds">
          <div>
            Available margin
            <Wallet size={17} />
          </div>
          <strong>{formatAccountMoney(balances.availableFunds)}</strong>
          <p>All connected brokers · buying power, not transferable cash</p>
        </article>
        <button
          className={`${styles.metric} ${styles.metricButton}`}
          onClick={onTogglePositions}
          aria-expanded={showPositions}
          aria-controls="overview-positions"
        >
          <div>
            Open positions
            <Activity size={17} />
          </div>
          <strong>
            {combined.knownBooks
              ? `${combined.positions.length}${combined.complete ? "" : "+"}`
              : "—"}
          </strong>
          <p>
            All connected brokers
            {combined.complete ? "" : " · incomplete coverage"}
          </p>
        </button>
        <article
          className={styles.metric}
          aria-label="Live position profit and loss"
        >
          <div>
            Live position P&amp;L <Activity size={17} />
          </div>
          <strong className={getPnlClassName(combined.pnl)}>
            {formatAccountMoney(combined.pnl)}
          </strong>
          <p>
            All connected brokers ·{" "}
            {combined.pnl !== null
              ? "last known marks"
              : "complete valuation unavailable"}
          </p>
        </article>
        <button
          className={`${styles.metric} ${styles.metricButton}`}
          onClick={onToggleHoldings}
          aria-expanded={showHoldings}
          aria-controls="overview-holdings"
        >
          <div>
            Holdings
            <BriefcaseBusiness size={17} />
          </div>
          <strong>
            {balances.knownHoldingBooks
              ? `${balances.holdings.length}${balances.holdingsComplete ? "" : "+"}`
              : "—"}
          </strong>
          <p>
            All connected brokers · pledged shares{" "}
            {balances.pledgedQuantity?.toLocaleString("en-IN") ?? "—"}
          </p>
        </button>
        <button
          className={`${styles.metric} ${styles.metricButton}`}
          onClick={onNavigateTo("Brokers")}
          aria-label="Manage broker connections"
        >
          <div>
            Broker connection <Radio size={17} />
          </div>
          <strong>
            {registry.loading || positionsLoading
              ? "Checking…"
              : `${connectedCount} of ${books.length} connected`}
          </strong>
          <p>
            Manage all broker sessions <ArrowRight size={12} />
          </p>
        </button>
      </div>

      {/* Separate timestamps and failures explain which accounts contribute to the overview. */}
      <Card
        className={styles.accountStrip}
        aria-label="Connected accounts summary"
      >
        <div className={styles.accountToolbar}>
          <div>
            <strong>All connected accounts</strong>
            <span>
              Read-only snapshots · active broker is used only for live trading
            </span>
          </div>
          <button
            className={styles.refresh}
            disabled={positionsLoading || !books.length}
            onClick={onRefreshSnapshot}
          >
            <RefreshCw size={14} />
            {positionsLoading
              ? "Loading snapshots…"
              : "Refresh all connected accounts"}
          </button>
        </div>
        {books.map(({ id, name, account: book }) => (
          <div key={id} className={styles.notice}>
            <strong>{name}</strong> ·{" "}
            {book.loading
              ? "Loading…"
              : book.error || book.connected !== true
                ? "Account unavailable; displayed exposure is last known."
                : "Connected"}
            <p>
              Available margin: {formatAccountMoney(book.live?.availableFunds)}{" "}
              · Snapshot:{" "}
              {book.live
                ? new Date(book.live.capturedAt).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  }) + " IST"
                : "Not loaded"}{" "}
              · {book.feedMessage}
            </p>
            {book.live?.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ))}
        {balances.invalidHoldingBrokers.map((name) => (
          <p key={name} className={styles.notice}>
            {name}: holdings unavailable because the response contains
            derivatives, not a verified demat book. Excluded from holdings
            totals.
          </p>
        ))}
        {!registry.loading && !books.length && (
          <p className={styles.notice}>
            <a href="#/brokers">Connect a broker</a> to load funds and
            positions.
          </p>
        )}
        {showPositions && (
          <div id="overview-positions" className={styles.positionTable}>
            <p className={styles.tableCaption}>
              Open positions · all connected brokers
            </p>
            {books.map(({ id, name, account: book }) => (
              <div key={id} className={styles.notice}>
                {name} ·{" "}
                {book.loading
                  ? "Loading…"
                  : book.error ||
                      book.connected !== true ||
                      !book.live?.positions
                    ? "Position data unavailable; any displayed rows are last known exposure."
                    : `${book.live.positions.length} open positions · ${new Date(book.live.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST · ${book.feedMessage}`}
                {book.live?.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ))}
            {positionsLoading && !combined.knownBooks ? (
              <SkeletonRows rows={3} columns={5} />
            ) : !combined.knownBooks ? (
              <EmptyState
                title="Position data is unavailable"
                description="It is not assumed to be an empty account."
              />
            ) : (
              <>
                <DataTable
                  columns={positionColumns}
                  rows={combined.positions}
                  rowKey={(position) => position.id}
                  emptyTitle={
                    combined.complete
                      ? "No open positions"
                      : "No known open positions"
                  }
                  emptyDescription={
                    combined.complete
                      ? "All connected brokers reported an empty position book."
                      : "Some account data is unavailable; this does not confirm a flat portfolio."
                  }
                />
              </>
            )}
          </div>
        )}
        {showHoldings && (
          <div id="overview-holdings" className={styles.positionTable}>
            {positionsLoading && !balances.knownHoldingBooks ? (
              <SkeletonRows rows={3} columns={8} />
            ) : !balances.knownHoldingBooks ? (
              <EmptyState
                title="Holdings data is unavailable"
                description="It is not assumed to be an empty demat account."
              />
            ) : (
              <>
                <p className={styles.tableCaption}>
                  Holdings · all connected brokers
                  {balances.holdingsComplete
                    ? ""
                    : " · incomplete coverage; some rows may be last known"}
                </p>
                <DataTable
                  columns={holdingColumns}
                  rows={balances.holdings}
                  rowKey={(holding) => holding.id}
                  emptyTitle={
                    balances.holdingsComplete
                      ? "No holdings"
                      : "No known holdings"
                  }
                  emptyDescription={
                    balances.holdingsComplete
                      ? "All connected brokers reported an empty demat book."
                      : "Some holdings are unavailable; this is not a confirmed empty portfolio."
                  }
                />
              </>
            )}
          </div>
        )}
      </Card>

      <NseMarketIntelligence />

      {/* Activity stays read-only; quick actions navigate to their dedicated workflows. */}
      <div className={styles.contentGrid}>
        <Card aria-label="Recent activity">
          <CardHeader>
            <div>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>
                Latest 5 workspace events · all times IST
              </CardDescription>
            </div>
            <button
              className={styles.cardHeadingLink}
              onClick={onNavigateTo("Activity log")}
            >
              View all <ArrowRight size={14} />
            </button>
          </CardHeader>
          {recentEvents.length ? (
            <ol className={styles.activityList}>
              {recentEvents.map(
                /** Display each real audit event; selecting it reveals its full details. */ (
                  event,
                ) => (
                  <li key={event.id}>
                    <time dateTime={event.created_at}>
                      {formatActivityTime(event.created_at)}
                    </time>
                    <span className={styles.activityDot} />
                    <button onClick={onOpenActivity(event)}>
                      <strong>{event.message}</strong>
                      <span>Workspace event #{event.id}</span>
                    </button>
                  </li>
                ),
              )}
            </ol>
          ) : (
            <EmptyState
              icon={<Clock3 size={22} />}
              title="Your activity will appear here"
              description="Connect your broker to get started."
            />
          )}
        </Card>
        <div className={styles.sideCards}>
          <Card>
            <CardTitle>Quick actions</CardTitle>
            <div className={styles.quickActions}>
              <button
                className={styles.primary}
                onClick={onNavigateTo("Strategy lab")}
              >
                Create a strategy
              </button>
              <button onClick={onNavigateTo("Brokers")}>
                Connect a broker
              </button>
              <button onClick={onExploreOptionChain}>
                Explore option chain
              </button>
              <button onClick={onNavigateTo("Portfolio")}>
                View portfolio
              </button>
            </div>
          </Card>
          <Card aria-labelledby="readiness-title">
            <CardTitle id="readiness-title">Before you go live</CardTitle>
            <ul className={styles.checklist}>
              <li>
                <LockKeyhole size={17} />
                <span>Server capability</span>
                <Badge tone={workspace.live_configured ? "success" : "neutral"}>
                  {workspace.live_configured ? "Available" : "Disabled"}
                </Badge>
              </li>
              <li>
                <ShieldCheck size={17} />
                <span>Authenticator MFA</span>
                <Badge
                  tone={
                    account.mfaLoading
                      ? "neutral"
                      : account.mfaEnabled
                        ? "success"
                        : "warning"
                  }
                  role="status"
                >
                  {account.mfaLoading
                    ? "Checking…"
                    : account.mfaEnabled === null
                      ? "Unavailable"
                      : account.mfaEnabled
                        ? "Enabled"
                        : "Required"}
                </Badge>
                {!account.mfaLoading && account.mfaEnabled === null && (
                  <Button
                    variant="secondary"
                    className={styles.readinessAction}
                    onClick={account.refreshMfaStatus}
                    aria-label="Retry MFA status check"
                  >
                    Retry
                  </Button>
                )}
                {account.mfaEnabled === false && (
                  <Button
                    variant="secondary"
                    className={styles.readinessAction}
                    onClick={onNavigateTo("Account & security")}
                  >
                    Set up MFA <ArrowRight size={12} />
                  </Button>
                )}
              </li>
              <li>
                <Radio size={17} />
                <span>Broker sessions</span>
                <Badge
                  tone={
                    registry.loading || positionsLoading
                      ? "neutral"
                      : connectedCount > 0
                        ? "success"
                        : "warning"
                  }
                >
                  {registry.loading || positionsLoading
                    ? "Checking"
                    : connectedCount > 0
                      ? `${connectedCount} connected`
                      : "Required"}
                </Badge>
                {!registry.loading && connectedCount === 0 && (
                  <Button
                    variant="secondary"
                    className={styles.readinessAction}
                    onClick={onNavigateTo("Brokers")}
                  >
                    Connect <ArrowRight size={12} />
                  </Button>
                )}
              </li>
              <li>
                <Check size={17} />
                <span>Risk limits &amp; authorization</span>
                <Button
                  variant="secondary"
                  className={styles.readinessAction}
                  onClick={onNavigateTo("Live trading")}
                >
                  {workspace.live_configured ? "Review" : "Requirements"}{" "}
                  <ArrowRight size={12} />
                </Button>
              </li>
            </ul>
            <p className={styles.readinessNote}>
              Connection and trading permission are separate. Check all controls
              before placing a live order.
            </p>
          </Card>
        </div>
      </div>
      <footer className={styles.footer}>
        <span>NRIAlgo / Overview · Personal workspace</span>
        <span>
          <Wallet size={13} /> All connected brokers
        </span>
      </footer>
      <Dialog
        open={activityDialogOpen}
        onClose={onActivityClosed}
        title="Activity details"
        labelledBy="overview-event-title"
      >
        {selectedEvent && (
          <>
            <DialogDescription>{selectedEvent.message}</DialogDescription>
            <dl className={styles.eventDetails}>
              <dt>Event ID</dt>
              <dd>{selectedEvent.id}</dd>
              <dt>Time (IST)</dt>
              <dd>{formatActivityTime(selectedEvent.created_at)}</dd>
              <dt>Source</dt>
              <dd>Authenticated workspace audit history</dd>
            </dl>
          </>
        )}
      </Dialog>
    </section>
  );
}
