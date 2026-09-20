"use client";
/** Live position monitoring uses the same account adapter and valuation model as Overview. */
import { useRef, useState } from "react";
import { Info } from "lucide-react";
import { clsx } from "clsx";
import { LiveOrderTicket } from "./live-order-ticket";
import { TradingViewDrafts, type TradingViewDraft } from "./tradingview-drafts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogActions,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useOverviewAccount } from "@/features/overview/use-overview-account";
import { brokerAccountAdapters } from "@/features/overview/providers/broker-account-adapters";
import { useBrokerRegistry } from "@/features/brokers/broker-hooks";
import {
  formatAccountMoney,
  type AccountPosition,
} from "@/features/overview/account-model";
import styles from "./live-trading-screen.module.css";

/** No order is placed or account armed by opening this screen. */
export function LiveTradingScreen({ csrf }: { csrf: string }) {
  const registry = useBrokerRegistry(csrf);
  const activeBroker = registry.brokers.find(
    (item) => item.id === registry.activeBrokerId,
  );
  // Never substitute another broker when the selected account expires or cannot be verified.
  const broker =
    !registry.error && activeBroker?.status === "connected"
      ? (brokerAccountAdapters.find(
          (item) => item.id === activeBroker.provider,
        ) ?? null)
      : null;
  const account = useOverviewAccount(broker, csrf);
  const toast = useToast();
  const [selected, setSelected] = useState<AccountPosition | null>(null);
  const [ticketDraft, setTicketDraft] = useState<TradingViewDraft | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  /** Inspect exposure only; no close order, broker reconciliation or account arming happens here. */
  function reviewPosition(position: AccountPosition) {
    setSelected(position);
    setReviewOpen(true);
  }
  /** Feedback-only wrapper; the underlying snapshot fetch, cancellation and retained-value
   * semantics are owned entirely by useOverviewAccount and are not changed here. */
  async function handleRefresh() {
    const result = await account.loadAccountSnapshot();
    if (result === true) {
      toast({ tone: "success", title: "Position snapshot refreshed" });
    } else if (typeof result === "string") {
      toast({ tone: "error", title: "Refresh failed", description: result });
    }
  }
  const pnlExplanation = `Open-position P&L uses received contract marks and the broker position basis; it is not the account-wide unrealized total. Broker-reported account unrealized P&L: ${formatAccountMoney(account.live?.reportedUnrealizedPnl)}. Snapshot-only screens may show unavailable marks until a quote is received. A recently received price is not proof of a recent exchange trade.`;
  const pnl = account.live?.pnl;
  const positionColumns: DataTableColumn<AccountPosition>[] = [
    { key: "symbol", header: "Instrument", render: (p) => p.symbol },
    {
      key: "quantity",
      header: "Units",
      align: "right",
      sortValue: (p) => p.quantity,
      render: (p) => <span className={styles.mono}>{p.quantity}</span>,
    },
    {
      key: "average",
      header: "Average",
      align: "right",
      render: (p) => (
        <span className={styles.mono}>
          {formatAccountMoney(p.averagePrice)}
        </span>
      ),
    },
    {
      key: "mark",
      header: "Mark",
      align: "right",
      render: (p) => (
        <span className={styles.mono}>{formatAccountMoney(p.markPrice)}</span>
      ),
    },
    {
      key: "pnl",
      header: "Position P&L",
      align: "right",
      sortValue: (p) => p.pnl ?? 0,
      render: (p) => (
        <span
          className={clsx(
            styles.mono,
            typeof p.pnl === "number" &&
              (p.pnl >= 0 ? styles.positive : styles.negative),
          )}
        >
          {formatAccountMoney(p.pnl)}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (p) => (
        <Button variant="ghost" onClick={() => reviewPosition(p)}>
          View position
        </Button>
      ),
    },
  ];
  return (
    <section className="screen-stack" aria-label="Live position monitoring">
      <TradingViewDrafts
        csrf={csrf}
        onAccept={(draft) => {
          setTicketDraft(draft);
          window.requestAnimationFrame(() =>
            controls.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            }),
          );
        }}
      />
      <Card className={styles.intro}>
        <p className={styles.introLead}>
          <strong>Monitor exposure independently of execution</strong>
        </p>
        <p className={styles.introNote}>
          Viewing positions never arms trading. Account snapshots load once;
          subsequent marks use the shared price feed.
        </p>
      </Card>
      {registry.error && (
        <p role="alert" className={styles.alert}>
          {registry.error}
        </p>
      )}
      <p className={styles.contextNote}>
        Execution account:{" "}
        <strong>
          {activeBroker?.provider.toUpperCase() ?? "Not selected"}
        </strong>{" "}
        <Badge
          tone={
            registry.loading
              ? "neutral"
              : activeBroker?.status === "connected"
                ? "success"
                : "warning"
          }
        >
          {registry.loading
            ? "Checking connection…"
            : (activeBroker?.status ?? "Not connected")}
        </Badge>
        . Viewing positions does not change this selection.{" "}
        <a href="#/brokers">Manage broker connections</a>
      </p>
      <div className={styles.statsGrid}>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>
            Open position P&amp;L
            <Tooltip label={pnlExplanation}>
              <button
                type="button"
                className={styles.infoTrigger}
                aria-label="What does open-position P&L mean?"
              >
                <Info size={13} />
              </button>
            </Tooltip>
          </span>
          <strong
            className={clsx(
              styles.statValue,
              styles.mono,
              typeof pnl === "number" &&
                (pnl >= 0 ? styles.positive : styles.negative),
            )}
          >
            {formatAccountMoney(pnl)}
          </strong>
        </Card>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>Available margin</span>
          <strong className={clsx(styles.statValue, styles.mono)}>
            {formatAccountMoney(account.live?.availableFunds)}
          </strong>
        </Card>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>Open positions</span>
          <strong className={clsx(styles.statValue, styles.mono)}>
            {account.live?.positions?.length ?? "—"}
          </strong>
        </Card>
      </div>
      <div ref={controls} className="screen-card">
        <LiveOrderTicket
          key={`${registry.activeBrokerId}:${activeBroker?.status}:${ticketDraft?.id ?? "manual"}`}
          csrf={csrf}
          initialDraft={ticketDraft ?? undefined}
        />
      </div>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Positions</CardTitle>
            <CardDescription>
              {broker?.name ?? "No connected execution account"} ·{" "}
              {account.live
                ? `${new Date(account.live.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST snapshot`
                : "Snapshot not loaded"}
            </CardDescription>
          </div>
          <Button
            variant="secondary"
            disabled={account.loading || !broker}
            onClick={() => void handleRefresh()}
          >
            Refresh position snapshot
          </Button>
        </CardHeader>
        {account.error && (
          <p role="alert" className={styles.alert}>
            {account.error} Retained values may be stale.
          </p>
        )}
        {account.live?.warnings.map((warning) => (
          <p key={warning} role="status" className={styles.status}>
            {warning}
          </p>
        ))}
        <AsyncBoundary status={account.loading ? "loading" : "success"}>
          {account.connected === false ? (
            <p className={styles.contextNote}>
              <a href="#/brokers">Connect or select a broker</a> to load
              positions.
            </p>
          ) : account.live?.positions ? (
            <DataTable
              columns={positionColumns}
              rows={account.live.positions}
              rowKey={(p) => p.id}
              emptyTitle="No open positions in the broker snapshot."
            />
          ) : (
            <p className={styles.contextNote}>
              Positions are unavailable, not assumed to be an empty account.
            </p>
          )}
        </AsyncBoundary>
        <p className={styles.tableFooter}>
          {account.feedMessage}. Values use last known marks. Available margin
          is broker buying power, not a cash ledger.
        </p>
      </Card>
      {/* Safety controls remain visible instead of hiding the halt action inside a disclosure. */}
      <Card>
        <CardTitle>Position safety</CardTitle>
        <p className={styles.safetyText}>
          Halt in the execution controls blocks new entries and requests
          cancellation of app-owned orders; it does not close positions. Use the
          broker platform to manage external positions or emergencies.
        </p>
        <p className={styles.safetyText}>
          To close multiple or externally managed positions, use your broker
          platform. This app does not offer a bulk exit.
        </p>
      </Card>
      <Dialog
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Position details"
        labelledBy="review-exit-title"
      >
        {selected && (
          <>
            <p className={styles.reviewMeta}>
              {selected.symbol} ·{" "}
              <span className={styles.mono}>{selected.quantity}</span> units ·
              last mark{" "}
              <span className={styles.mono}>
                {formatAccountMoney(selected.markPrice)}
              </span>
            </p>
            <DialogDescription>
              This is a read-only exposure review, not an executable preview.
              External/manual positions cannot be adopted by this app. For an
              app-owned position, select its exact contract and request a fresh
              reduce-only limit preview in the guarded ticket.
            </DialogDescription>
            <DialogActions>
              <Button
                onClick={() => {
                  setReviewOpen(false);
                  controls.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }}
              >
                Review execution controls
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </section>
  );
}
