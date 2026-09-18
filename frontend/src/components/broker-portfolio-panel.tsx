"use client";
/** Explicit read-only account snapshot. No paper wallet or execution API is called here. */
import { useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { KotakAccountReports } from "./kotak-account-reports";
type Row = {
  symbol: string;
  exchange: string;
  product: string;
  quantity: number;
  averagePrice: number | null;
  markPrice: number | null;
  pnl: number | null;
  expiry: string;
  right: string;
  strike: string;
};
type Section = { rows: Row[] | null; error: string | null };
type Snapshot = { observedAt: number; positions: Section; holdings: Section };
/** Broker monetary fields are rupees, unlike the paper ledger's integer paise. */
const rupees = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
      }).format(value);
/** Render read-only broker holdings/positions separately from virtual balances. */
export function BrokerPortfolioPanel({
  broker,
  csrf,
}: {
  broker: "kotak";
  csrf: string;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  /** Clear old account data before every fetch; failures must never look like an empty account. */
  async function refresh() {
    setBusy(true);
    setSnapshot(null);
    setError("");
    try {
      const data = await requestApiJson(
        `/portfolio/${broker}/refresh`,
        "POST",
        undefined,
        csrf,
        95000,
      );
      setSnapshot(data);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Portfolio unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="paper-wallet" aria-label="Broker portfolio">
      <h3>Broker portfolio — read only</h3>
      {broker === "kotak" && <KotakAccountReports csrf={csrf} />}
      <p>
        Real account positions and holdings. Never merged with paper cash, paper
        positions or simulated P&amp;L. Connect the selected broker first;
        live-order execution is not required.
      </p>
      <p>
        Kotak positions cover positions returned by its current-day trades API;
        untraded carry-forward positions may not be included. Values are
        broker-reported snapshots, not guaranteed live marks. Missing values
        remain unavailable.
      </p>
      <Button disabled={busy} onClick={() => void refresh()}>
        {busy ? "Fetching broker portfolio…" : "Refresh broker portfolio"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {snapshot && (
        <>
          <p>Fetched {new Date(snapshot.observedAt).toLocaleString("en-IN")}</p>
          {(["positions", "holdings"] as const).map((kind) => {
            const section = snapshot[kind],
              rows = section.rows?.filter(
                (row) => kind === "holdings" || row.quantity !== 0,
              );
            return (
              <div key={kind}>
                <h4>
                  {kind === "positions"
                    ? "Broker open positions"
                    : "Broker holdings"}
                </h4>
                {section.error ? (
                  <p role="alert">{section.error}</p>
                ) : (
                  <>
                    <p>
                      {rows?.length || 0} rows returned
                      {kind === "positions"
                        ? " with non-zero net quantity"
                        : ""}
                      .
                    </p>
                    <div className="paper-table">
                      <table>
                        <thead>
                          <tr>
                            {[
                              "Instrument",
                              "Exchange / product",
                              "Units",
                              "Average",
                              "Reported mark",
                              "Reported P&L",
                            ].map((label) => (
                              <th key={label}>{label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows?.map((row, index) => (
                            <tr key={index}>
                              <td>
                                {row.symbol} {row.expiry} {row.strike}{" "}
                                {row.right}
                              </td>
                              <td>
                                {row.exchange} {row.product}
                              </td>
                              <td>{row.quantity}</td>
                              <td>{rupees(row.averagePrice)}</td>
                              <td>{rupees(row.markPrice)}</td>
                              <td>{rupees(row.pnl)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
