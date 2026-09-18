"use client";
/** Local historical CSV workbench. No generated prices, external upload or execution side effects. */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  strategyTemplates,
  type TemplateId,
} from "@/features/strategy-library/strategy-templates";
import type { BacktestSettings } from "./daily-backtest";
import { useDailyBacktest } from "./use-daily-backtest";
import { formatInr } from "@/lib/format";
import { downloadText } from "@/lib/download";

/** Keep uploaded data/results private to this mounted screen; changing input invalidates the report. */
export function BacktestStudioScreen({
  templateId = "ema",
  onBrowse,
}: {
  templateId?: TemplateId;
  onBrowse: () => void;
}) {
  const template = strategyTemplates.find((item) => item.id === templateId)!;
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
    filename,
    report,
    error,
    loading,
    running,
    selectFile,
    run,
    invalidateReport,
  } = useDailyBacktest();
  /** Start local calculation; the hook owns validation, failure state and immutable input binding. */
  function onRun() {
    void run(settings);
  }
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
        <Button variant="secondary" onClick={onBrowse}>
          Browse templates
        </Button>
      </div>
      <div className="environment">
        <div>
          <strong>{filename || "Historical data required"}</strong>
          <span>
            {bars.length
              ? `${bars.length} daily candles · ${bars[0].date} to ${bars.at(-1)!.date} · user-supplied, provenance not independently verified`
              : "Select your historical daily OHLC CSV. Data is processed locally and is not sent to a broker."}
          </span>
        </div>
      </div>
      <section className="panel screen-card">
        <h2>Rules and parameters</h2>
        <p>
          {template.entry} {template.exit}
        </p>
        <div className="research-fields">
          {fields.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
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
          <Button disabled={!bars.length || loading || running} onClick={onRun}>
            {running ? "Calculating…" : "Run calculated backtest"}
          </Button>
          <label>
            Upload daily CSV
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={
                /** The hook catches file-read/parse failures and ignores superseded reads. */ (
                  event,
                ) => void selectFile(event.target.files?.[0])
              }
            />
          </label>
        </div>
        <p>
          CSV: date,open,high,low,close · 60–10,000 rows · ascending unique
          YYYY-MM-DD dates · maximum 2 MB.
        </p>
        {loading && <p role="status">Validating historical data…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
      <article className="panel screen-card">
        <h2>Execution assumptions and limitations</h2>
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
      </article>
      {!report ? (
        <article className="panel screen-card">
          <h2>Ready to test</h2>
          <p>
            Upload historical data and run the selected rules. Results will be
            calculated from your inputs.
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
              {report.manifest.filename} · {report.from} to {report.to}
            </p>
            <p style={{ overflowWrap: "anywhere" }}>
              Dataset SHA-256: {report.manifest.datasetHash}
              <br />
              Configuration SHA-256: {report.manifest.configurationHash}
              <br />
              Engine: {report.manifest.engineVersion} · Local result; download
              to retain.
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
