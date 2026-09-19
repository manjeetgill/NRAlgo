"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BriefcaseBusiness, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestApiJson } from "@/lib/api";
import {
  clubPortfolioRows,
  completeTotal,
  portfolioRegistrySchema,
  portfolioSnapshotSchema,
  type PortfolioDisplayRow,
  type PortfolioKind,
  type PortfolioProvider,
  type PortfolioSnapshot,
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

/** Read-only connected-account portfolio with explicit single/all selection. */
export function PortfolioScreen({ csrf }: { csrf: string }) {
  const [providers, setProviders] = useState<PortfolioProvider[]>([]);
  const [selection, setSelection] = useState<"all" | PortfolioProvider>("all");
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void requestApiJson(
      "/brokers",
      "GET",
      undefined,
      undefined,
      15000,
      controller.signal,
    )
      .then((value) => {
        const registry = portfolioRegistrySchema.parse(value);
        setProviders(
          registry.brokers
            .filter((broker) => broker.status === "connected")
            .map((broker) => broker.provider)
            .sort((left, right) =>
              providerLabels[left].localeCompare(providerLabels[right]),
            ),
        );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Connected portfolios are unavailable.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setRegistryLoading(false);
        }
      });
    return () => controller.abort();
  }, [csrf]);

  const rows = useMemo(
    () => ({
      holdings: clubPortfolioRows(snapshots, "holdings"),
      positions: clubPortfolioRows(snapshots, "positions"),
    }),
    [snapshots],
  );

  async function loadPortfolio() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const targets = selection === "all" ? providers : [selection];
    setLoading(true);
    setSnapshots([]);
    setWarnings([]);
    setError("");
    try {
      const results = await Promise.allSettled(
        targets.map(async (provider) =>
          portfolioSnapshotSchema.parse(
            await requestApiJson(
              `/portfolio/${provider}/refresh`,
              "POST",
              undefined,
              csrf,
              95000,
              controller.signal,
            ),
          ),
        ),
      );
      if (controller.signal.aborted) {
        return;
      }
      const loaded: PortfolioSnapshot[] = [];
      const failures: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          loaded.push(result.value);
          for (const kind of ["holdings", "positions"] as const) {
            if (result.value[kind].error) {
              failures.push(result.value[kind].error);
            }
          }
        } else {
          failures.push(
            `${providerLabels[targets[index]!]}: ${
              result.reason instanceof Error
                ? result.reason.message
                : "portfolio unavailable"
            }`,
          );
        }
      });
      setSnapshots(loaded);
      setWarnings(failures);
      if (!loaded.length) {
        setError("No selected portfolio could be loaded.");
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }

  const expectedPortfolios = selection === "all" ? providers.length : 1;
  const holdingsComplete =
    snapshots.length === expectedPortfolios &&
    snapshots.every(
      (snapshot) =>
        snapshot.holdings.rows !== null && snapshot.holdings.error === null,
    );
  const holdingsInvested = holdingsComplete
    ? completeTotal(rows.holdings, "investedAmount")
    : null;
  const holdingsValue = holdingsComplete
    ? completeTotal(rows.holdings, "currentValue")
    : null;
  const holdingPnl = holdingsComplete
    ? completeTotal(rows.holdings, "pnl")
    : null;

  return (
    <section className={styles.screen} aria-label="Portfolio">
      <header className={styles.header}>
        <div>
          <h1>
            <BriefcaseBusiness size={24} /> Portfolio
          </h1>
          <p>
            View one connected broker portfolio or club all connected real
            accounts in a single read-only view.
          </p>
        </div>
        <div className={styles.selector}>
          <label>
            Portfolio
            <select
              value={selection}
              disabled={registryLoading || loading}
              onChange={(event) => {
                setSelection(event.target.value as "all" | PortfolioProvider);
                setSnapshots([]);
                setWarnings([]);
                setError("");
              }}
            >
              <option value="all">All connected portfolios</option>
              <optgroup label="Accounts">
                {providers.map((provider) => (
                  <option key={provider} value={provider}>
                    {providerLabels[provider]}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <Button
            disabled={registryLoading || loading || !providers.length}
            onClick={() => void loadPortfolio()}
          >
            <RefreshCw size={14} />
            {loading ? "Loading…" : snapshots.length ? "Refresh" : "Load"}
          </Button>
        </div>
      </header>

      {!registryLoading && !providers.length && (
        <p className={styles.empty}>
          Connect Kotak Neo or Zerodha Kite in Broker connections to view a real
          portfolio.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {warnings.map((warning) => (
        <p className={styles.warning} role="status" key={warning}>
          {warning} Any affected combined totals remain unavailable until every
          selected book loads successfully.
        </p>
      ))}
      {!snapshots.length && providers.length > 0 && !error && (
        <p className={styles.empty}>
          Select one account or All connected portfolios, then load its latest
          broker-reported snapshot.
        </p>
      )}
      {snapshots.length > 0 && (
        <>
          <div className={styles.metrics}>
            <Metric label="Invested amount" value={money(holdingsInvested)} />
            <Metric
              label="Current holding value"
              value={money(holdingsValue)}
            />
            <Metric
              label="Unrealized holding P&L"
              value={money(holdingPnl)}
              tone={holdingPnl}
            />
            <Metric
              label="Portfolios loaded"
              value={`${snapshots.length} of ${expectedPortfolios}`}
            />
          </div>
          <PortfolioTable kind="holdings" rows={rows.holdings} />
          <PortfolioTable kind="positions" rows={rows.positions} />
          <p className={styles.disclaimer}>
            Values are broker-reported snapshots. This screen cannot submit,
            modify or authorize an order. Paper trading remains separate.
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
    <article>
      <span>{label}</span>
      <strong
        className={
          typeof tone !== "number" ? "" : tone < 0 ? styles.loss : styles.gain
        }
      >
        {value}
      </strong>
    </article>
  );
}

function PortfolioTable({
  kind,
  rows,
}: {
  kind: PortfolioKind;
  rows: PortfolioDisplayRow[];
}) {
  return (
    <section className={styles.tableCard}>
      <div className={styles.tableHeading}>
        <div>
          <h2>{kind === "holdings" ? "Holdings" : "Open positions"}</h2>
          <p>{rows.length} clubbed instruments</p>
        </div>
      </div>
      {!rows.length ? (
        <p className={styles.tableEmpty}>No non-zero {kind} were returned.</p>
      ) : (
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Portfolio</th>
                <th>Qty</th>
                <th>Average</th>
                <th>Invested amount</th>
                <th>LTP</th>
                <th>Current value</th>
                <th>Reported P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${kind}-${row.exchange}-${row.instrumentToken}-${row.product}-${row.quantity < 0 ? "short" : "long"}`}
                >
                  <td>
                    <strong>{row.symbol}</strong>
                    <small>
                      {row.exchange} {row.product}
                    </small>
                  </td>
                  <td>
                    {row.providers
                      .map((provider) => providerLabels[provider])
                      .join(", ")}
                  </td>
                  <td>{row.quantity.toLocaleString("en-IN")}</td>
                  <td>{money(row.averagePrice)}</td>
                  <td>{money(row.investedAmount)}</td>
                  <td>{money(row.markPrice)}</td>
                  <td>{money(row.currentValue)}</td>
                  <td
                    className={
                      row.pnl !== null && row.pnl < 0
                        ? styles.loss
                        : styles.gain
                    }
                  >
                    {money(row.pnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
