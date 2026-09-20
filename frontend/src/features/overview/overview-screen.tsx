"use client";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
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
  X,
} from "lucide-react";
import { brokerAccountAdapters } from "@/features/overview/providers/broker-account-adapters";
import { useBrokerRegistry } from "@/features/brokers/broker-hooks";
import {
  formatAccountMoney,
  formatActivityTime,
  type OverviewDestination,
  type OverviewWorkspace,
} from "@/features/overview/account-model";
import { useOverviewAccount } from "@/features/overview/use-overview-account";
import { NseMarketIntelligence } from "@/features/overview/nse-market-intelligence";
import { orderAuditEvents } from "@/features/activity/audit-model";
import styles from "@/features/overview/overview-screen.module.css";
import { Button } from "@/components/ui/button";

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
  const registry = useBrokerRegistry(workspace.csrf);
  const connectedBrokers = useMemo(() => {
    const connectedProviders = new Set(
      registry.brokers
        .filter((item) => item.status === "connected")
        .map((item) => item.provider),
    );
    return brokerAccountAdapters.filter((adapter) =>
      connectedProviders.has(adapter.id as "kotak" | "zerodha"),
    );
  }, [registry.brokers]);
  const [brokerId, setBrokerId] = useState("");
  const [showPositions, setShowPositions] = useState(false);
  const [showHoldings, setShowHoldings] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<
    OverviewWorkspace["events"][number] | null
  >(null);
  const activityDialog = useRef<HTMLDialogElement>(null);
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
  /** Bind a navigation destination without granting any trading permissions. */
  const onNavigateTo = (destination: OverviewDestination) => {
    /** Forward the user's click to the workspace shell. */
    return () => onNavigate(destination);
  };
  /** Unknown valuations receive no profit/loss color. */
  const getPnlClassName = (value: number | null | undefined) =>
    value === null || value === undefined || !Number.isFinite(value)
      ? ""
      : value < 0
        ? styles.negative
        : styles.positive;

  /** Switch adapters; the account hook invalidates pending responses and reloads the baseline. */
  function onBrokerChange(event: ChangeEvent<HTMLSelectElement>) {
    setBrokerId(event.target.value);
    setShowPositions(false);
    setShowHoldings(false);
  }
  /** Explicitly request one snapshot; the hook owns promise rejection and loading state. */
  function onRefreshSnapshot() {
    void account.loadAccountSnapshot();
  }
  /** Expand/collapse the selected account's table without refetching reports. */
  function onTogglePositions() {
    setShowPositions(!showPositions);
  }
  /** Expand/collapse demat holdings without triggering another broker request. */
  function onToggleHoldings() {
    setShowHoldings(!showHoldings);
  }
  /** Bind the chosen audit event to the native, keyboard-accessible details dialog. */
  function onOpenActivity(event: OverviewWorkspace["events"][number]) {
    /** Open the dialog on user intent, leaving focus trapping and Escape handling to the browser. */
    return () => {
      setSelectedEvent(event);
      activityDialog.current?.showModal();
    };
  }
  /** Clear details after either Escape or the close button dismisses the dialog. */
  function onActivityClosed() {
    setSelectedEvent(null);
  }
  /** Close the native dialog and restore focus to its triggering activity button. */
  function onCloseActivity() {
    activityDialog.current?.close();
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
      <section
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
        <div className={styles.accountMetrics}>
          <div>
            <span>Available margin</span>
            <strong>{formatAccountMoney(snapshot?.availableFunds)}</strong>
            <small>Broker buying power · not a cash ledger</small>
          </div>
          <button
            aria-expanded={showPositions}
            aria-controls="overview-positions"
            onClick={onTogglePositions}
          >
            <span>Open positions</span>
            <strong>{snapshot?.positions?.length ?? "—"}</strong>
            <small>
              {showPositions
                ? "Hide position details"
                : "View position details"}{" "}
              <ArrowRight size={12} />
            </small>
          </button>
          <button
            aria-expanded={showHoldings}
            aria-controls="overview-holdings"
            onClick={onToggleHoldings}
          >
            <span>Holdings</span>
            <strong>{snapshot?.holdings?.length ?? "—"}</strong>
            <small>
              Pledged shares ·{" "}
              {pledgedQuantity?.toLocaleString("en-IN") ?? "Unavailable"}{" "}
              <ArrowRight size={12} />
            </small>
          </button>
          <div>
            <span>Snapshot</span>
            <strong className={styles.timestamp}>
              {snapshot
                ? new Date(snapshot.capturedAt).toLocaleTimeString("en-IN", {
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
        {!registry.loading && !broker && (
          <p className={styles.notice}>
            Connect a broker in Broker connections to load funds and positions.
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
            {!snapshot?.positions ? (
              <p>
                Position data is unavailable. It is not assumed to be an empty
                account.
              </p>
            ) : !snapshot.positions.length ? (
              <p>No open positions in this live account.</p>
            ) : (
              <table>
                <caption>
                  Live open positions · {broker?.name ?? "No connected broker"}
                </caption>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Units</th>
                    <th>Average</th>
                    <th>Mark</th>
                    <th>Position P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.positions.map(
                    /** Render the same marked position objects used by the headline P&L. */ (
                      position,
                    ) => (
                      <tr key={position.id}>
                        <td>{position.symbol}</td>
                        <td>{position.quantity}</td>
                        <td>{formatAccountMoney(position.averagePrice)}</td>
                        <td>{formatAccountMoney(position.markPrice)}</td>
                        <td className={getPnlClassName(position.pnl)}>
                          {formatAccountMoney(position.pnl)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}
        {showHoldings && (
          <div id="overview-holdings" className={styles.positionTable}>
            {!snapshot?.holdings ? (
              <p>
                Holdings data is unavailable. It is not assumed to be an empty
                demat account.
              </p>
            ) : !snapshot.holdings.length ? (
              <p>No holdings in this live account.</p>
            ) : (
              <table>
                <caption>
                  Live holdings · {broker?.name ?? "No connected broker"}
                </caption>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Total units</th>
                    <th>Pledged</th>
                    <th>T1 / unsettled</th>
                    <th>Average</th>
                    <th>LTP</th>
                    <th>Current value</th>
                    <th>Holding P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.holdings.map(
                    /** Show every normalized holding field; unavailable broker fields remain dashes. */ (
                      holding,
                    ) => (
                      <tr key={holding.id}>
                        <td>
                          {holding.symbol}
                          <small className={styles.instrumentMeta}>
                            {holding.exchange} {holding.product}
                          </small>
                        </td>
                        <td>{holding.quantity.toLocaleString("en-IN")}</td>
                        <td>
                          {holding.pledgedQuantity?.toLocaleString("en-IN") ??
                            "—"}
                        </td>
                        <td>
                          {holding.t1Quantity?.toLocaleString("en-IN") ?? "—"}
                        </td>
                        <td>{formatAccountMoney(holding.averagePrice)}</td>
                        <td>{formatAccountMoney(holding.markPrice)}</td>
                        <td>
                          {formatAccountMoney(
                            holding.markPrice === null
                              ? null
                              : holding.quantity * holding.markPrice,
                          )}
                        </td>
                        <td className={getPnlClassName(holding.pnl)}>
                          {formatAccountMoney(holding.pnl)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <NseMarketIntelligence />

      {/* Activity stays read-only; quick actions navigate to their dedicated workflows. */}
      <div className={styles.contentGrid}>
        <section className={styles.card} aria-label="Recent activity">
          <div className={styles.cardHeading}>
            <div>
              <h2>Recent activity</h2>
              <p>Latest 5 workspace events · all times IST</p>
            </div>
            <button onClick={onNavigateTo("Activity log")}>
              View all <ArrowRight size={14} />
            </button>
          </div>
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
            <div className={styles.empty}>
              <Clock3 size={26} />
              <h3>Your activity will appear here</h3>
              <p>Connect your broker to get started.</p>
            </div>
          )}
        </section>
        <div className={styles.sideCards}>
          <section className={styles.card}>
            <h2>Quick actions</h2>
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
          </section>
          <section className={styles.card} aria-labelledby="readiness-title">
            <h2 id="readiness-title">Before you go live</h2>
            <ul className={styles.checklist}>
              <li>
                <LockKeyhole size={17} />
                <span>Server capability</span>
                <strong
                  className={styles.readinessBadge}
                  data-tone={workspace.live_configured ? "ready" : "neutral"}
                >
                  {workspace.live_configured ? "Available" : "Disabled"}
                </strong>
              </li>
              <li>
                <ShieldCheck size={17} />
                <span>Authenticator MFA</span>
                <strong
                  className={styles.readinessBadge}
                  data-tone={
                    account.mfaLoading
                      ? "neutral"
                      : account.mfaEnabled
                        ? "ready"
                        : "attention"
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
                </strong>
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
                <strong
                  className={styles.readinessBadge}
                  data-tone={
                    registry.loading || account.connected === null
                      ? "neutral"
                      : account.connected
                        ? "ready"
                        : "attention"
                  }
                >
                  {registry.loading || account.connected === null
                    ? "Checking"
                    : account.connected
                      ? "Connected"
                      : "Required"}
                </strong>
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
          </section>
        </div>
      </div>
      <footer className={styles.footer}>
        <span>NRIAlgo / Overview · Live workspace</span>
        <span>
          <Wallet size={13} /> {broker?.name ?? "No connected broker"}
        </span>
      </footer>
      {/* Native dialog supplies modal focus containment and Escape-to-close behavior. */}
      <dialog
        ref={activityDialog}
        className={styles.eventDialog}
        aria-labelledby="overview-event-title"
        onClose={onActivityClosed}
      >
        <div>
          <h2 id="overview-event-title">Activity details</h2>
          <button aria-label="Close activity details" onClick={onCloseActivity}>
            <X size={18} />
          </button>
        </div>
        {selectedEvent && (
          <>
            <p>{selectedEvent.message}</p>
            <dl>
              <dt>Event ID</dt>
              <dd>{selectedEvent.id}</dd>
              <dt>Time (IST)</dt>
              <dd>{formatActivityTime(selectedEvent.created_at)}</dd>
              <dt>Source</dt>
              <dd>Authenticated workspace audit history</dd>
            </dl>
          </>
        )}
      </dialog>
    </section>
  );
}
