"use client";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
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
  type AccountHolding,
  type AccountPosition,
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
  const [brokerId, setBrokerId] = useState("");
  const [showPositions, setShowPositions] = useState(false);
  const [showHoldings, setShowHoldings] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<
    OverviewWorkspace["events"][number] | null
  >(null);
  const [activityDialogOpen, setActivityDialogOpen] = useState(false);
  /** Default to the saved broker; never substitute another account after expiry. */
  useEffect(() => {
    const activeProvider = registry.brokers.find(
      (item) =>
        item.id === registry.activeBrokerId && item.status === "connected",
    )?.provider;
    setBrokerId(
      connectedBrokers.find((item) => item.id === activeProvider)?.id ?? "",
    );
  }, [connectedBrokers, registry.activeBrokerId, registry.brokers]);
  const broker = connectedBrokers.find((item) => item.id === brokerId) ?? null;
  const account = useOverviewAccount(broker, workspace.csrf);
  const snapshot = account.live;
  const pledgedQuantity = useMemo(() => {
    if (
      !snapshot?.holdings ||
      snapshot.holdings.some((holding) => holding.pledgedQuantity === null)
    ) {
      return null;
    }
    return snapshot.holdings.reduce(
      /** A verified empty book correctly totals to zero; unknown rows were rejected above. */ (
        total,
        holding,
      ) => total + holding.pledgedQuantity!,
      0,
    );
  }, [snapshot?.holdings]);
  const recentEvents = orderAuditEvents(workspace.events).slice(0, 5);
  const positionColumns = useMemo<DataTableColumn<AccountPosition>[]>(
    () => [
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
  const holdingColumns = useMemo<DataTableColumn<AccountHolding>[]>(
    () => [
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

  /** Switch adapters; the account hook invalidates pending responses and reloads the baseline. */
  function onBrokerChange(event: ChangeEvent<HTMLSelectElement>) {
    setBrokerId(event.target.value);
    setShowPositions(false);
    setShowHoldings(false);
  }
  /** Explicitly request one snapshot; the hook owns promise rejection and loading state.
   * Surfaces the outcome as a toast — the hook's own request/error handling is unchanged. */
  async function onRefreshSnapshot() {
    const result = await account.loadAccountSnapshot();
    if (result === true) {
      toast({
        tone: "success",
        title: "Snapshot refreshed",
        description: broker
          ? `${broker.name} funds and positions are up to date.`
          : undefined,
      });
    } else if (typeof result === "string") {
      toast({ tone: "error", title: "Refresh failed", description: result });
    }
  }
  /** Expand/collapse the selected account's table without refetching reports. */
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
      {/* Broker selection controls the adapter; no provider API fields leak into this header. */}
      <header className={styles.heading}>
        <div>
          <h1>Your trading workspace</h1>
          <p>Know what needs attention, then get back to your work.</p>
        </div>
        <label className={styles.brokerSelect}>
          Broker account
          <select
            value={brokerId}
            onChange={onBrokerChange}
            disabled={registry.loading || !connectedBrokers.length}
          >
            {!registry.loading && connectedBrokers.length > 0 && !brokerId && (
              <option value="">
                Reconnect or select your active broker in Settings
              </option>
            )}
            {registry.loading ? (
              <option value="">Loading connected brokers…</option>
            ) : !connectedBrokers.length ? (
              <option value="">No connected brokers</option>
            ) : (
              connectedBrokers.map(
                /** Render only connected providers with implemented account adapters. */ (
                  item,
                ) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ),
              )
            )}
          </select>
        </label>
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

      {/* Headline values come from the selected account snapshot, never fabricated constants. */}
      <div className={styles.metrics}>
        <article className={styles.metric} aria-label="Available account funds">
          <div>
            Available margin
            <Wallet size={17} />
          </div>
          <strong>{formatAccountMoney(snapshot?.availableFunds)}</strong>
          <p>Broker buying power · not cash balance</p>
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
          <strong>{snapshot?.positions?.length ?? "—"}</strong>
          <p>View positions and their latest marks</p>
        </button>
        <article
          className={styles.metric}
          aria-label="Live position profit and loss"
        >
          <div>
            Live position P&amp;L <Activity size={17} />
          </div>
          <strong className={getPnlClassName(account.live?.pnl)}>
            {formatAccountMoney(account.live?.pnl)}
          </strong>
          <p>
            {account.live
              ? "Open broker positions · last known marks"
              : account.connected
                ? "Refresh snapshot to load broker positions"
                : "Connect your broker to view"}
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
          <strong>{snapshot?.holdings?.length ?? "—"}</strong>
          <p>
            Pledged shares · {pledgedQuantity?.toLocaleString("en-IN") ?? "—"}
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
            {account.connected === null
              ? "—"
              : account.connected
                ? "Connected"
                : "Not connected"}
          </strong>
          <p>
            {broker?.name ?? "No connected broker"} · session status{" "}
            <ArrowRight size={12} />
          </p>
        </button>
      </div>

      {/* Explicit snapshot controls and a single selected-book view prevent cross-mode mixing. */}
      <Card
        className={styles.accountStrip}
        aria-label="Selected account summary"
      >
        <div className={styles.accountToolbar}>
          <div>
            <strong>Live account</strong>
            <span>
              {broker?.name ?? "No connected broker"} · Read-only broker
              snapshot
            </span>
          </div>
          <button
            className={styles.refresh}
            disabled={account.loading || !broker}
            onClick={onRefreshSnapshot}
          >
            <RefreshCw size={14} />
            {account.loading ? "Loading snapshot…" : "Refresh snapshot"}
          </button>
        </div>
        {account.loading && !snapshot ? (
          <SkeletonRows rows={1} columns={1} />
        ) : (
          <div className={styles.accountMetrics}>
            <div>
              <span>Account snapshot captured</span>
              <strong className={styles.timestamp}>
                {snapshot
                  ? new Date(snapshot.capturedAt).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                    }) + " IST"
                  : "Not loaded"}
              </strong>
              <small>
                {snapshot?.positions?.length
                  ? account.feedMessage
                  : "Refresh explicitly to reload account data"}
              </small>
            </div>
          </div>
        )}
        {!registry.loading && !broker && (
          <p className={styles.notice}>
            <a href="#/brokers">Connect a broker</a> to load funds and
            positions.
          </p>
        )}
        {broker && account.connected === false && (
          <p className={styles.notice}>
            Connect {broker.name} in Broker connections to load funds and
            positions.
          </p>
        )}
        {account.error && (
          <p className={styles.error} role="alert">
            {account.error} Values, if shown, are the last successful snapshot.
          </p>
        )}
        {snapshot?.warnings.map(
          /** Preserve partial-report warnings alongside any last known values. */ (
            warning,
          ) => (
            <p className={styles.notice} key={warning}>
              {warning}
            </p>
          ),
        )}
        {showPositions && (
          <div id="overview-positions" className={styles.positionTable}>
            {account.loading && !snapshot?.positions ? (
              <SkeletonRows rows={3} columns={5} />
            ) : !snapshot?.positions ? (
              <EmptyState
                title="Position data is unavailable"
                description="It is not assumed to be an empty account."
              />
            ) : (
              <>
                <p className={styles.tableCaption}>
                  Live open positions · {broker?.name ?? "No connected broker"}
                </p>
                <DataTable
                  columns={positionColumns}
                  rows={snapshot.positions}
                  rowKey={(position) => position.id}
                  emptyTitle="No open positions"
                  emptyDescription="No open positions in this live account."
                />
              </>
            )}
          </div>
        )}
        {showHoldings && (
          <div id="overview-holdings" className={styles.positionTable}>
            {account.loading && !snapshot?.holdings ? (
              <SkeletonRows rows={3} columns={8} />
            ) : !snapshot?.holdings ? (
              <EmptyState
                title="Holdings data is unavailable"
                description="It is not assumed to be an empty demat account."
              />
            ) : (
              <>
                <p className={styles.tableCaption}>
                  Live holdings · {broker?.name ?? "No connected broker"}
                </p>
                <DataTable
                  columns={holdingColumns}
                  rows={snapshot.holdings}
                  rowKey={(holding) => holding.id}
                  emptyTitle="No holdings"
                  emptyDescription="No holdings in this live account."
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
                <span>Broker session</span>
                <Badge
                  tone={
                    registry.loading || account.connected === null
                      ? "neutral"
                      : account.connected
                        ? "success"
                        : "warning"
                  }
                >
                  {registry.loading || account.connected === null
                    ? "Checking"
                    : account.connected
                      ? "Connected"
                      : "Required"}
                </Badge>
                {!registry.loading && account.connected === false && (
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
          <Wallet size={13} /> {broker?.name ?? "No connected broker"}
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
