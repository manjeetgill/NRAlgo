"use client";
/** Stored historical workbench. No broker login, uploaded/generated prices or execution side effects. */
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  PageActions,
  useUnsavedResearchWarning,
} from "@/features/workspace/workspace-views";
import {
  strategyTemplates,
  type TemplateId,
} from "@/features/strategy-library/strategy-templates";
import type { BacktestSettings } from "./backtest-report";
import { useDailyBacktest } from "./use-daily-backtest";
import { formatInr } from "@/lib/format";
import { downloadText } from "@/lib/download";
import { StoredInstrumentPicker } from "@/components/stored-instrument-picker";
import type { StoredInstrument } from "@/lib/stored-market-data";

/** Keep stored data/results private to this mounted screen; changing input invalidates the report. */
export function BacktestStudioScreen({
  csrf,
  templateId = "ema",
  onBrowse,
}: {
  csrf: string;
  templateId?: TemplateId;
  onBrowse: () => void;
}) {
  const template = strategyTemplates.find((item) => item.id === templateId)!;
  const [instrument, setInstrument] = useState<StoredInstrument | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [settings, setSettings] = useState<BacktestSettings>({
    template: templateId,
    first: template.defaults[0],
    second: template.defaults[1],
    capital: 100000,
    allocation: 20,
    stop: 2,
    target: 4,
    fee: 20,
    slippage: 5,
  });
  const {
    bars,
    history,
    report,
    error,
    loading,
    running,
    progress,
    loadHistory,
    clearDataset,
    run,
    cancelJob,
    invalidateReport,
  } = useDailyBacktest(csrf);
  const initialSettings = useRef(settings);
  useUnsavedResearchWarning(
    Boolean(instrument || from || to) ||
      running ||
      JSON.stringify(settings) !== JSON.stringify(initialSettings.current),
  );
  /** Create a durable Python job; the hook owns polling, cancellation and result validation. */
  function onRun() {
    if (runBlocked) {
      return;
    }
    void run(settings);
  }
  // Match the engine's warm-up requirement without calculating strategy results in React.
  const requiredBars = Math.max(
    60,
    (templateId === "rsi"
      ? settings.first + 1
      : Math.max(settings.first, settings.second)) + 2,
  );
  const parameterError =
    !Number.isInteger(settings.first) ||
    !Number.isInteger(settings.second) ||
    settings.first < 2 ||
    settings.first > 500 ||
    settings.second < 2 ||
    settings.second > 500
      ? "Use whole-number indicator parameters between 2 and 500."
      : templateId === "ema" && settings.first >= settings.second
        ? "Fast EMA must be shorter than slow EMA."
        : templateId === "rsi" &&
            (settings.second <= 30 || settings.second >= 100)
          ? "Exit RSI must be above 30 and below 100."
          : ![
                settings.capital,
                settings.allocation,
                settings.stop,
                settings.target,
                settings.fee,
                settings.slippage,
              ].every(Number.isFinite) ||
              settings.capital < 100 ||
              settings.capital > 10000000 ||
              settings.allocation <= 0 ||
              settings.allocation > 100 ||
              settings.stop <= 0 ||
              settings.stop >= 100 ||
              settings.target <= 0 ||
              settings.target > 1000 ||
              settings.fee < 0 ||
              settings.fee > 10000 ||
              settings.slippage < 0 ||
              settings.slippage > 500
            ? "Check capital (₹100–1 crore), allocation (0–100%), stop (0–100%), target (0–1,000%), fee (₹0–10,000), and slippage (0–500 bps). Zero allocation, stop and target are not allowed."
            : "";
  const runBlocked =
    parameterError ||
    (!instrument
      ? "Choose a stored instrument to begin."
      : loading
        ? "Wait for history to finish loading."
        : !bars.length
          ? "Choose a date range and load stored history."
          : bars.length < requiredBars
            ? `Load at least ${requiredBars} candles for these parameters; ${bars.length} are available in this range.`
            : "");
  const fields: [keyof Omit<BacktestSettings, "template">, string][] = [
    ["first", template.first],
    ["second", template.second],
    ["capital", "Starting capital ₹"],
    ["allocation", "Cash allocation per entry %"],
    ["stop", "Stop-loss %"],
    ["target", "Profit target %"],
    ["fee", "Flat fee per fill ₹"],
    ["slippage", "Slippage per fill · basis points"],
  ];
  const values = report?.equity.map((point) => point.value) ?? [];
  const low = Math.min(...values),
    high = Math.max(...values),
    span = Math.max(1, high - low);
  return (
    <section className="screen-stack" aria-label="Historical backtest studio">
      <div className="screen-toolbar">
        <p>{template.name} · v1.0 · daily cash-equity model</p>
        <PageActions>
          <Button variant="secondary" onClick={onBrowse}>
            Browse templates
          </Button>
        </PageActions>
      </div>
      <div className="environment">
        <div>
          <strong>
            {history
              ? `${history.instrument.symbol} · ${history.source}`
              : "Stored historical data required"}
          </strong>
          <span>
            {bars.length
              ? `${bars.length} stored daily candles · ${bars[0].date} to ${bars.at(-1)!.date}`
              : "Select an instrument from the stored catalog. No broker connection is required and calculation does not place orders."}
          </span>
        </div>
      </div>
      <section className="panel screen-card">
        <h2>1. Instrument and date range</h2>
        <StoredInstrumentPicker
          disabled={running}
          onClear={() => {
            setInstrument(null);
            clearDataset();
          }}
          onSelect={(selected) => {
            clearDataset();
            setInstrument(selected);
            const latestYear = new Date(
              Date.parse(selected.last_day) - 365 * 86400000,
            )
              .toISOString()
              .slice(0, 10);
            setFrom(
              latestYear < selected.first_day ? selected.first_day : latestYear,
            );
            setTo(selected.last_day);
          }}
        />
        <p>
          Selected:{" "}
          {instrument
            ? `${instrument.symbol} · ${instrument.kind} · available ${instrument.first_day} to ${instrument.last_day}`
            : "Choose a cash instrument above"}
        </p>
        <div className="research-fields">
          <label>
            From (IST)
            <input
              type="date"
              disabled={running}
              value={from}
              min={instrument?.first_day}
              max={to || instrument?.last_day}
              onChange={(event) => {
                clearDataset();
                setFrom(event.target.value);
              }}
            />
          </label>
          <label>
            To (IST)
            <input
              type="date"
              disabled={running}
              value={to}
              min={from || instrument?.first_day}
              max={instrument?.last_day}
              onChange={(event) => {
                clearDataset();
                setTo(event.target.value);
              }}
            />
          </label>
        </div>
        <Button
          disabled={
            !instrument || loading || running || !from || !to || from > to
          }
          onClick={() => {
            if (instrument) {
              void loadHistory(instrument, from, to);
            }
          }}
        >
          {loading ? "Loading stored history…" : "Load stored history"}
        </Button>
        <p>
          Stored daily equity/index history · up to 10,000 sessions · at least
          60 valid trading candles required. Missing sessions are not padded.
        </p>
        {history && (
          <p>
            Fetched {new Date(history.fetchedAt).toLocaleString("en-IN")} ·{" "}
            {history.adjustmentPolicy}
          </p>
        )}
      </section>
      <section className="panel screen-card">
        <h2>2. Rules and assumptions</h2>
        <p>
          {template.entry} {template.exit}
        </p>
        <div className="research-fields">
          {fields.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                disabled={running}
                step={key === "first" || key === "second" ? "1" : "0.01"}
                value={settings[key]}
                onChange={(event) => {
                  setSettings({
                    ...settings,
                    [key]: Number(event.target.value),
                  });
                  invalidateReport();
                }}
              />
            </label>
          ))}
        </div>
        <div className="screen-toolbar">
          <Button
            aria-describedby="backtest-readiness"
            disabled={Boolean(runBlocked) || running}
            onClick={onRun}
          >
            {running ? `Calculating… ${progress}%` : "Run backtest"}
          </Button>
          {running && (
            <Button variant="secondary" onClick={cancelJob}>
              Cancel calculation
            </Button>
          )}
        </div>
        <p id="backtest-readiness" role="status">
          {running
            ? "Calculation in progress. You can cancel this calculation below."
            : runBlocked ||
              "Ready to run on stored data. This never places a broker order."}
        </p>
        <p className="muted">
          Slippage models a worse fill price. 5 basis points = 0.05% per fill;
          fees apply to both entry and exit.
        </p>
        {loading && <p role="status">Validating historical data…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
      <details className="panel screen-card backtest-assumptions">
        <summary>Execution assumptions and limitations</summary>
        <p>
          Completed-bar signals fill at the next open. One long cash position,
          integer shares, no leverage. Stops and targets use the entry fill.
          Gaps exit at the open; when both levels are touched, stop is assumed
          first. Adverse slippage and a flat fee apply to each fill. Remaining
          positions close at the final bar close.
        </p>
        <p>
          Drawdown uses bar-close equity. Taxes, corporate actions, liquidity,
          variable brokerage and intrabar sequencing are not modeled. Use
          consistent adjusted historical data; results do not predict future
          returns.
        </p>
      </details>
      {!report ? (
        <article className="panel screen-card">
          <h2>Ready to test</h2>
          <p>
            Load stored historical data and run the selected rules. Results will
            be calculated from those candles and your parameters.
          </p>
        </article>
      ) : (
        <>
          <div className="research-summary">
            <div>
              <span>Net return</span>
              <strong>{report.returnPercent.toFixed(2)}%</strong>
            </div>
            <div>
              <span>Maximum drawdown</span>
              <strong>{report.drawdownPercent.toFixed(2)}%</strong>
            </div>
            <div>
              <span>Closed trades</span>
              <strong>{report.trades.length}</strong>
            </div>
            <div>
              <span>Win rate</span>
              <strong>
                {report.winRate === null
                  ? "—"
                  : `${report.winRate.toFixed(1)}%`}
              </strong>
            </div>
          </div>
          <article className="panel screen-card">
            <h2>Calculated equity curve</h2>
            <p>
              {report.manifest.request.stockCode} · {report.manifest.provider} ·{" "}
              {report.from} to {report.to}
            </p>
            <p style={{ overflowWrap: "anywhere" }}>
              Dataset SHA-256: {report.manifest.datasetHash}
              <br />
              Configuration SHA-256: {report.manifest.configurationHash}
              <br />
              Engine: {report.manifest.engineVersion} · Durable calculation job.
            </p>
            <svg
              viewBox="0 0 760 210"
              role="img"
              aria-label="Calculated daily closing equity"
            >
              <polyline
                fill="none"
                stroke="#335cde"
                strokeWidth="2"
                points={values
                  .map(
                    (value, index) =>
                      `${20 + (index * 720) / Math.max(1, values.length - 1)},${190 - ((value - low) / span) * 170}`,
                  )
                  .join(" ")}
              />
            </svg>
            <div className="research-summary">
              <div>
                <span>Ending equity</span>
                <strong>{formatInr(report.endingEquity)}</strong>
              </div>
              <div>
                <span>Profit factor</span>
                <strong>
                  {report.profitFactor === null
                    ? report.trades.length
                      ? "— (no losing trades)"
                      : "— (no trades)"
                    : report.profitFactor.toFixed(2)}
                </strong>
              </div>
              <div>
                <span>Total modeled fees</span>
                <strong>{formatInr(report.totalFees)}</strong>
              </div>
            </div>
            <p>
              {report.skippedEntries} entries skipped for insufficient
              allocation.
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                downloadText(
                  "backtest-results.json",
                  JSON.stringify(report, null, 2),
                  "application/json",
                )
              }
            >
              Export results JSON
            </Button>
          </article>
          <article className="panel screen-card">
            <h2>Trade ledger</h2>
            <p>
              {report.trades.length} calculated trades · latest 50 shown ·
              export includes every trade.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Qty</th>
                    <th>Buy</th>
                    <th>Sell</th>
                    <th>Net P&amp;L</th>
                    <th>Exit reason</th>
                  </tr>
                </thead>
                <tbody>
                  {report.trades.slice(-50).map((trade, index) => (
                    <tr key={index}>
                      <td>{trade.entryDate}</td>
                      <td>{trade.exitDate}</td>
                      <td>{trade.quantity}</td>
                      <td>{formatInr(trade.entry)}</td>
                      <td>{formatInr(trade.exit)}</td>
                      <td>{formatInr(trade.pnl)}</td>
                      <td>{trade.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </>
      )}
    </section>
  );
}
