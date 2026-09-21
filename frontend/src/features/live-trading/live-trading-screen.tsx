"use client";
/** Live position monitoring uses the same account adapter and valuation model as Overview.
 * Every connected broker contributes positions/funds here, read-only; only the broker
 * currently authorized for live execution (the "active" broker) can be traded from this screen.
 */
import { useMemo, useRef, useState } from "react";
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

/** One position tagged with its originating broker; tradable only when that broker is
 * the account currently authorized for live execution (the app supports one at a time). */
type BookPosition = AccountPosition & { brokerName: string; tradable: boolean };

/** No order is placed or account armed by opening this screen. */
export function LiveTradingScreen({ csrf }: { csrf: string }) {
  const registry = useBrokerRegistry(csrf);
  const activeBroker = registry.brokers.find(
    (item) => item.id === registry.activeBrokerId,
  );
  const connectedProviders = useMemo(
    () =>
      new Set(
        registry.brokers
          .filter((item) => item.status === "connected")
          .map((item) => item.provider),
      ),
    [registry.brokers],
  );
  const connectedBrokers = useMemo(
    () =>
      brokerAccountAdapters.filter((adapter) =>
        connectedProviders.has(adapter.id as "kotak" | "zerodha" | "icici"),
      ),
    [connectedProviders],
  );
  // Never substitute another broker when the selected execution account expires or cannot
  // be verified; this is the ONE account live orders are placed through.
  const broker =
    !registry.error && activeBroker?.status === "connected"
      ? (brokerAccountAdapters.find(
          (item) => item.id === activeBroker.provider,
        ) ?? null)
      : null;
  // Fixed hook order: every connected broker's snapshot loads independently, so one
  // slow/failed account never hides another's positions.
  const kotak = useOverviewAccount(
    connectedBrokers.find((item) => item.id === "kotak") ?? null,
    csrf,
  );
  const zerodha = useOverviewAccount(
    connectedBrokers.find((item) => item.id === "zerodha") ?? null,
    csrf,
  );
  const icici = useOverviewAccount(
    connectedBrokers.find((item) => item.id === "icici") ?? null,
    csrf,
  );
  const accounts = { kotak, zerodha, icici };
  const books = connectedBrokers.map((adapter) => ({
    ...adapter,
    account: accounts[adapter.id as keyof typeof accounts],
  }));
  const positionsLoading = books.some((book) => book.account.loading);
  const positions: BookPosition[] = books.flatMap(({ id, name, account }) =>
    (account.live?.positions ?? []).map((position) => ({
      ...position,
      id: `${id}:${position.id}`,
      brokerName: name,
      tradable: name === broker?.name,
    })),
  );
  const positionsComplete =
    books.length > 0 &&
    books.every(
      (book) =>
        book.account.connected === true &&
        Array.isArray(book.account.live?.positions),
    );
  const combinedPnl =
    positionsComplete &&
    positions.every(
      (position) => position.pnl !== null && Number.isFinite(position.pnl),
    )
      ? positions.reduce((total, position) => total + position.pnl!, 0)
      : null;
  const fundsComplete =
    books.length > 0 &&
    books.every(
      (book) =>
        book.account.connected === true &&
        typeof book.account.live?.availableFunds === "number" &&
        Number.isFinite(book.account.live.availableFunds),
    );
  const combinedFunds = fundsComplete
    ? books.reduce(
        (total, book) => total + book.account.live!.availableFunds!,
        0,
      )
    : null;
  const toast = useToast();
  const [selected, setSelected] = useState<BookPosition | null>(null);
  const [ticketDraft, setTicketDraft] = useState<TradingViewDraft | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  /** Inspect exposure only; no close order, broker reconciliation or account arming happens here. */
  function reviewPosition(position: BookPosition) {
    setSelected(position);
    setReviewOpen(true);
  }
  /** Feedback-only wrapper; the underlying snapshot fetch, cancellation and retained-value
   * semantics are owned entirely by useOverviewAccount and are not changed here. */
  async function handleRefresh() {
    const results = await Promise.all(
      books.map((book) => book.account.loadAccountSnapshot()),
    );
    const errors = results.filter(
      (result): result is string => typeof result === "string",
    );
    if (results.length && results.every((result) => result === true)) {
      toast({ tone: "success", title: "Position snapshots refreshed" });
    } else if (errors.length) {
      toast({
        tone: "error",
        title: "Some accounts could not refresh",
        description: errors.join(" "),
      });
    }
  }
  const pnlExplanation = `Open-position P&L uses received contract marks and each broker's position basis; it is not the account-wide unrealized total. Snapshot-only screens may show unavailable marks until a quote is received. A recently received price is not proof of a recent exchange trade.${
    books.some(
      (book) => typeof book.account.live?.reportedUnrealizedPnl === "number",
    )
      ? " Broker-reported account unrealized P&L: " +
        books
          .filter(
            (book) =>
              typeof book.account.live?.reportedUnrealizedPnl === "number",
          )
          .map(
            (book) =>
              `${book.name} ${formatAccountMoney(book.account.live!.reportedUnrealizedPnl)}`,
          )
          .join(" · ") +
        "."
      : ""
  }`;
  const positionColumns: DataTableColumn<BookPosition>[] = [
    {
      key: "broker",
      header: "Broker",
      render: (p) => p.brokerName,
      sortValue: (p) => p.brokerName,
    },
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
          {p.tradable ? "View position" : "View (read-only)"}
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
          Every connected broker&apos;s positions are shown here, read-only.
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
        Execution account (the only broker orders can be placed through):{" "}
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
        . Positions from other connected brokers are shown read-only below.{" "}
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
              typeof combinedPnl === "number" &&
                (combinedPnl >= 0 ? styles.positive : styles.negative),
            )}
          >
            {formatAccountMoney(combinedPnl)}
          </strong>
          <span className={styles.statLabel}>All connected brokers</span>
        </Card>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>Available margin</span>
          <strong className={clsx(styles.statValue, styles.mono)}>
            {formatAccountMoney(combinedFunds)}
          </strong>
          <span className={styles.statLabel}>All connected brokers</span>
        </Card>
        <Card className={styles.statCard}>
          <span className={styles.statLabel}>Open positions</span>
          <strong className={clsx(styles.statValue, styles.mono)}>
            {books.length
              ? `${positions.length}${positionsComplete ? "" : "+"}`
              : "—"}
          </strong>
          <span className={styles.statLabel}>All connected brokers</span>
        </Card>
      </div>
      <div ref={controls} className="screen-card">
        <LiveOrderTicket
          key={`${registry.activeBrokerId}:${activeBroker?.status}:${ticketDraft?.id ?? "manual"}`}
          csrf={csrf}
          activeBroker={activeBroker}
          brokerStatusUnavailable={registry.loading || Boolean(registry.error)}
          initialDraft={ticketDraft ?? undefined}
        />
      </div>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Positions</CardTitle>
            <CardDescription>
              All connected brokers ·{" "}
              {books.length
                ? `${books.length} account${books.length === 1 ? "" : "s"}`
                : "No connected broker"}
            </CardDescription>
          </div>
          <Button
            variant="secondary"
            disabled={positionsLoading || !books.length}
            onClick={() => void handleRefresh()}
          >
            Refresh position snapshots
          </Button>
        </CardHeader>
        {books.map(({ id, name, account }) =>
          account.error ? (
            <p key={id} role="alert" className={styles.alert}>
              {name}: {account.error} Retained values may be stale.
            </p>
          ) : null,
        )}
        {books.flatMap(({ id, name, account }) =>
          (account.live?.warnings ?? []).map((warning) => (
            <p key={`${id}:${warning}`} role="status" className={styles.status}>
              {name}: {warning}
            </p>
          )),
        )}
        <AsyncBoundary
          status={positionsLoading && !positions.length ? "loading" : "success"}
        >
          {!books.length ? (
            <p className={styles.contextNote}>
              <a href="#/brokers">Connect or select a broker</a> to load
              positions.
            </p>
          ) : positions.length || positionsComplete ? (
            <DataTable
              columns={positionColumns}
              rows={positions}
              rowKey={(p) => p.id}
              emptyTitle="No open positions in any connected broker's snapshot."
            />
          ) : (
            <p className={styles.contextNote}>
              Positions are unavailable, not assumed to be an empty account.
            </p>
          )}
        </AsyncBoundary>
        <p className={styles.tableFooter}>
          Values use last known marks. Available margin is broker buying power,
          not a cash ledger.
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
              {selected.brokerName} · {selected.symbol} ·{" "}
              <span className={styles.mono}>{selected.quantity}</span> units ·
              last mark{" "}
              <span className={styles.mono}>
                {formatAccountMoney(selected.markPrice)}
              </span>
            </p>
            <DialogDescription>
              This is a read-only exposure review, not an executable preview.
              External/manual positions cannot be adopted by this app.
              {selected.tradable
                ? " For an app-owned position, select its exact contract and request a fresh reduce-only limit preview in the guarded ticket."
                : ` This position is held with ${selected.brokerName}, which is not the broker currently authorized for live trading. Switch the active broker under Broker connections to trade it.`}
            </DialogDescription>
            <DialogActions>
              <Button
                disabled={!selected.tradable}
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
