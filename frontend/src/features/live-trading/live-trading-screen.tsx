"use client";
/** Live position monitoring uses the same account adapter and valuation model as Overview. */
import { useRef, useState } from "react";
import { LiveOrderTicket } from "./live-order-ticket";
import { Button } from "@/components/ui/button";
import { useOverviewAccount } from "@/features/overview/use-overview-account";
import { brokerAccountAdapters } from "@/features/overview/providers/broker-account-adapters";
import { useBrokerRegistry } from "@/features/brokers/broker-hooks";
import {
  formatAccountMoney,
  type AccountPosition,
} from "@/features/overview/account-model";
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
  const [selected, setSelected] = useState<AccountPosition | null>(null);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  /** Inspect exposure only; no close order, broker reconciliation or account arming happens here. */
  function reviewPosition(position: AccountPosition) {
    setSelected(position);
    reviewDialog.current?.showModal();
  }
  return (
    <section className="screen-stack" aria-label="Live position monitoring">
      <div className="environment">
        <div>
          <strong>Monitor exposure independently of execution</strong>
          <span>
            Viewing positions never arms trading. Account snapshots load once;
            subsequent marks use the shared price feed.
          </span>
        </div>
      </div>
      {registry.error && <p role="alert">{registry.error}</p>}
      <p className="account-context">
        Execution account:{" "}
        {activeBroker?.provider.toUpperCase() ?? "Not selected"} ·{" "}
        {registry.loading
          ? "Checking connection…"
          : (activeBroker?.status ?? "Not connected")}
        . Viewing positions does not change this selection.{" "}
        <a href="#/brokers">Manage broker connections</a>
      </p>
      <div className="research-summary">
        <div>
          <span>Open position P&amp;L</span>
          <strong>{formatAccountMoney(account.live?.pnl)}</strong>
        </div>
        <div>
          <span>Available margin</span>
          <strong>{formatAccountMoney(account.live?.availableFunds)}</strong>
        </div>
        <div>
          <span>Open positions</span>
          <strong>{account.live?.positions?.length ?? "—"}</strong>
        </div>
      </div>
      {/* Safety controls remain visible instead of hiding the halt action inside a disclosure. */}
      <div ref={controls} className="panel screen-card">
        <LiveOrderTicket
          key={`${registry.activeBrokerId}:${activeBroker?.status}`}
          csrf={csrf}
        />
      </div>
      <section className="panel screen-card">
        <div className="screen-toolbar">
          <div>
            <h2>Positions</h2>
            <p>
              {broker?.name ?? "No connected execution account"} ·{" "}
              {account.live
                ? `${new Date(account.live.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST snapshot`
                : "Snapshot not loaded"}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={account.loading || !broker}
            onClick={() => void account.loadAccountSnapshot()}
          >
            Refresh position snapshot
          </Button>
        </div>
        {account.loading && <p role="status">Loading broker positions…</p>}
        {account.error && (
          <p role="alert">{account.error} Retained values may be stale.</p>
        )}
        {account.connected === false && (
          <p>
            <a href="#/brokers">Connect or select a broker</a> to load
            positions.
          </p>
        )}
        {account.live?.warnings.map((warning) => (
          <p key={warning} role="status">
            {warning}
          </p>
        ))}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Units</th>
                <th>Average</th>
                <th>Mark</th>
                <th>Position P&amp;L</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {account.live?.positions?.map((position) => (
                <tr key={position.id}>
                  <td>{position.symbol}</td>
                  <td>{position.quantity}</td>
                  <td>{formatAccountMoney(position.averagePrice)}</td>
                  <td>{formatAccountMoney(position.markPrice)}</td>
                  <td>{formatAccountMoney(position.pnl)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => reviewPosition(position)}
                    >
                      View position
                    </Button>
                  </td>
                </tr>
              ))}
              {account.live?.positions?.length === 0 && (
                <tr>
                  <td colSpan={6}>No open positions in the broker snapshot.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!account.live?.positions && (
          <p>Positions are unavailable, not assumed to be an empty account.</p>
        )}
        <p className="muted">
          {account.feedMessage}. Values use last known marks. Available margin
          is broker buying power, not a cash ledger.
        </p>
      </section>
      <section className="panel screen-card">
        <h2>Position safety</h2>
        <p>
          Halt in the execution controls blocks new entries and requests
          cancellation of app-owned orders; it does not close positions. Use the
          broker platform to manage external positions or emergencies.
        </p>
        <p>
          To close multiple or externally managed positions, use your broker
          platform. This app does not offer a bulk exit.
        </p>
      </section>
      <dialog
        ref={reviewDialog}
        className="workspace-dialog"
        aria-labelledby="review-exit-title"
      >
        <div className="screen-toolbar">
          <h2 id="review-exit-title">Position details</h2>
          <Button
            variant="secondary"
            onClick={() => reviewDialog.current?.close()}
          >
            Close review
          </Button>
        </div>
        {selected && (
          <>
            <p>
              {selected.symbol} · {selected.quantity} units · last mark{" "}
              {formatAccountMoney(selected.markPrice)}
            </p>
            <p>
              This is a read-only exposure review, not an executable preview.
              External/manual positions cannot be adopted by this app. For an
              app-owned position, select its exact contract and request a fresh
              reduce-only limit preview in the guarded ticket.
            </p>
            <Button
              onClick={() => {
                reviewDialog.current?.close();
                if (controls.current) {
                  controls.current.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }
              }}
            >
              Review execution controls
            </Button>
          </>
        )}
      </dialog>
    </section>
  );
}
