"use client";
import { useRef, useState, type ChangeEvent } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  Clock3,
  FlaskConical,
  LockKeyhole,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { availableBrokers } from "@/features/overview/providers/kotak-account-adapter";
import {
  formatAccountMoney,
  formatActivityTime,
  type OverviewDestination,
  type OverviewWorkspace,
} from "@/features/overview/account-model";
import { useOverviewAccount } from "@/features/overview/use-overview-account";
import { NseMarketIntelligence } from "@/features/overview/nse-market-intelligence";
import { getTradingMode, isTradingEventVisible } from "@/lib/trading-mode";
import { orderAuditEvents } from "@/features/activity/audit-model";
import styles from "@/features/overview/overview-screen.module.css";

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
  const [brokerId, setBrokerId] = useState(availableBrokers[0].id);
  // The server setting selects one workspace; a local toggle cannot reveal a disabled mode.
  const mode = getTradingMode(workspace.paper_trading_enabled);
  const [showPositions, setShowPositions] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<
    OverviewWorkspace["events"][number] | null
  >(null);
  const activityDialog = useRef<HTMLDialogElement>(null);
  const broker =
    availableBrokers.find(
      /** Resolve only registered adapters; the selector cannot invent brokers. */ (
        item,
      ) => item.id === brokerId,
    ) ?? availableBrokers[0];
  const account = useOverviewAccount(broker, workspace.csrf, mode);
  const snapshot = mode === "paper" ? account.paper : account.live;
  const recentEvents = orderAuditEvents(workspace.events)
    .filter(
      /** Keep simulated history out of the live view without changing stored audit records. */ (
        event,
      ) => isTradingEventVisible(event.message, mode),
    )
    .slice(0, 5);
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
  }
  /** Explicitly request one snapshot; the hook owns promise rejection and loading state. */
  function onRefreshSnapshot() {
    void account.loadAccountSnapshot(mode);
  }
  /** Expand/collapse the selected account's table without refetching reports. */
  function onTogglePositions() {
    setShowPositions(!showPositions);
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
          <select value={brokerId} onChange={onBrokerChange}>
            {availableBrokers.map(
              /** Render implemented providers only, with stable adapter identifiers. */ (
                item,
              ) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ),
            )}
          </select>
        </label>
      </header>

      {/* Readiness is informative only; this screen cannot arm or submit orders. */}
      <section className={styles.banner} aria-label="Live trading readiness">
        <div>
          <strong>
            <LockKeyhole size={15} />
            {mode === "paper"
              ? "Paper trading workspace"
              : workspace.live_configured
                ? "Live execution requires explicit authorization"
                : "Live trading is locked"}
          </strong>
          <p>
            {mode === "paper"
              ? "Virtual funds and simulated orders only. No real orders are submitted from this workspace."
              : workspace.live_configured
                ? "Review your risk limits and arm live trading in its dedicated screen. Viewing this dashboard never enables orders."
                : "View your broker account and market data. Live execution is disabled on this server."}
          </p>
        </div>
        <button onClick={onNavigateTo("Account & security")}>
          Review security <ArrowRight size={14} />
        </button>
      </section>

      {/* Headline values come from the selected account snapshot, never fabricated constants. */}
      <div className={styles.metrics}>
        {mode === "paper" && (
          <article className={styles.metric} aria-label="Paper profit and loss">
            <div>
              Paper P&amp;L <FlaskConical size={17} />
            </div>
            <strong className={getPnlClassName(account.paper?.pnl)}>
              {formatAccountMoney(account.paper?.pnl)}
            </strong>
            <p>Realized + unrealized · paper ledger, all time</p>
          </article>
        )}
        <article className={styles.metric} aria-label="Available account funds">
          <div>
            {mode === "paper" ? "Available virtual cash" : "Available margin"}
            <Wallet size={17} />
          </div>
          <strong>{formatAccountMoney(snapshot?.availableFunds)}</strong>
          <p>
            {mode === "paper"
              ? "After order reservations"
              : "Broker buying power · not cash balance"}
          </p>
        </article>
        {mode === "live" && (
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
        )}
        {mode === "live" && (
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
        )}
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
            {broker.name} · session status <ArrowRight size={12} />
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
            <strong>
              {mode === "paper" ? "Paper account" : "Live account"}
            </strong>
            <span>
              {broker.name} ·{" "}
              {mode === "paper"
                ? "Simulated funds"
                : "Read-only broker snapshot"}
            </span>
          </div>
          <button
            className={styles.refresh}
            disabled={account.loading}
            onClick={onRefreshSnapshot}
          >
            <RefreshCw size={14} />
            {account.loading ? "Loading snapshot…" : "Refresh snapshot"}
          </button>
        </div>
        <div className={styles.accountMetrics}>
          <div>
            <span>
              {mode === "paper" ? "Available virtual cash" : "Available margin"}
            </span>
            <strong>{formatAccountMoney(snapshot?.availableFunds)}</strong>
            <small>
              {mode === "paper"
                ? "After open-order reservations"
                : "Broker buying power · not a cash ledger"}
            </small>
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
              {mode === "live" && snapshot?.positions?.length
                ? account.feedMessage
                : "Refresh explicitly to reload account data"}
            </small>
          </div>
        </div>
        {mode === "live" && account.connected === false && (
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
              <p>No open positions in this {mode} account.</p>
            ) : (
              <table>
                <caption>
                  {mode === "paper" ? "Paper" : "Live"} open positions ·{" "}
                  {broker.name}
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
          {mode === "live" && (
            <section className={styles.card}>
              <h2>Before you go live</h2>
              <ul className={styles.checklist}>
                <li>
                  <ShieldCheck size={17} />
                  <span>Authenticator MFA</span>
                  <strong>
                    {account.mfaEnabled === null
                      ? "Unknown"
                      : account.mfaEnabled
                        ? "Enabled"
                        : "Required"}
                  </strong>
                </li>
                <li>
                  <Radio size={17} />
                  <span>Broker session</span>
                  <strong>
                    {account.connected === null
                      ? "Checking"
                      : account.connected
                        ? "Connected"
                        : "Required"}
                  </strong>
                </li>
                <li>
                  <Check size={17} />
                  <span>Risk limits &amp; authorization</span>
                  <button onClick={onNavigateTo("Live trading")}>
                    Review <ArrowRight size={12} />
                  </button>
                </li>
              </ul>
              <p className={styles.readinessNote}>
                Connection and trading permission are separate. Check all
                controls before placing a live order.
              </p>
            </section>
          )}
        </div>
      </div>
      <footer className={styles.footer}>
        <span>
          NRIAlgo / Overview ·{" "}
          {mode === "paper" ? "Paper workspace" : "Live workspace"}
        </span>
        <span>
          <Wallet size={13} /> {broker.name}
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
