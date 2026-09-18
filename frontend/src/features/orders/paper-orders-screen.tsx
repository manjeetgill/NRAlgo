"use client";
/** Isolated historical synthetic fills; this component is never mounted in live mode. */
import { useMemo } from "react";
import { ArrowDownLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatInr as money } from "@/lib/format";
import type {
  WorkspaceSnapshot,
  WorkspacePage,
} from "@/features/workspace/workspace-types";
/** Memoize the job-to-fill projection so unrelated shell updates do not repeatedly flatten history. */
export function PaperOrdersScreen({
  workspace,
  onNavigate: setPage,
}: {
  workspace: WorkspaceSnapshot;
  onNavigate: (page: WorkspacePage) => void;
}) {
  const trades = useMemo(
    /** Join only these replay jobs with their own strategy names. */
    () =>
      workspace.jobs.flatMap((j) =>
        (j.result.trades || []).map((t, index) => ({
          ...t,
          id: `${j.id}-${index}`,
          strategy:
            workspace.strategies.find((s) => s.id === j.strategy_id)?.name ||
            "Strategy",
          date: j.created_at,
        })),
      ),
    [workspace.jobs, workspace.strategies],
  );
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h3>Simulated fills</h3>
          <p>
            Latest 30 runs · 0.05% slippage and ₹5 per order · taxes excluded
          </p>
        </div>
        <span className="badge purple">PAPER ONLY</span>
      </div>
      {!trades.length ? (
        <div className="empty">
          <ArrowDownLeft size={30} />
          <h3>No fills yet</h3>
          <p>Run a paper replay to see entry and exit fills here.</p>
          <Button variant="secondary" onClick={() => setPage("Strategies")}>
            Open strategies <ArrowRight size={14} />
          </Button>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>STRATEGY</th>
                <th>BAR</th>
                <th>SIDE</th>
                <th>UNITS</th>
                <th>FILL PRICE</th>
                <th>NET CLOSED P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>{t.strategy}</td>
                  <td>{t.bar + 1}</td>
                  <td>
                    <span
                      className={`badge ${t.side === "BUY" ? "green" : "purple"}`}
                    >
                      {t.side}
                    </span>
                  </td>
                  <td>{t.quantity}</td>
                  <td>{money(t.price)}</td>
                  <td className={(t.pnl || 0) >= 0 ? "positive" : "negative"}>
                    {t.pnl === null ? "—" : money(t.pnl)}
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
