"use client";
/** Saved research definitions are independent of paper wallets and live execution permission. */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageActions } from "@/features/workspace/workspace-views";
import { useStrategyLibrary } from "./use-strategy-library";

/** Search persisted owner-scoped definitions; opening a row never starts an order or replay. */
export function StrategiesScreen({
  csrf,
  onOpenStrategy,
}: {
  csrf: string;
  onOpenStrategy: (id: string, market: "cash" | "options") => void;
}) {
  const library = useStrategyLibrary(csrf);
  const [search, setSearch] = useState("");
  const [market, setMarket] = useState("all");
  const [status, setStatus] = useState("All");
  /** Recompute displayed rows only when the library or filters change. */
  const filtered = useMemo(
    () =>
      library.strategies.filter(
        (strategy) =>
          (status === "All" || status === "Saved") &&
          (market === "all" || strategy.definition.market === market) &&
          `${strategy.definition.name} ${strategy.definition.legs.map((leg) => leg.stockCode).join(" ")}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [library.strategies, search, market, status],
  );
  return (
    <section aria-label="Saved strategies" className="screen-stack">
      <PageActions>
        <Button onClick={() => onOpenStrategy("", "cash")}>New strategy</Button>
      </PageActions>
      <div className="panel screen-card">
        <div className="screen-toolbar strategy-toolbar">
          <div
            className="screen-filters"
            role="group"
            aria-label="Strategy status filter"
          >
            {["All", "Running", "Stopped", "Draft", "Saved"].map((value) => (
              <Button
                key={value}
                variant={status === value ? "primary" : "secondary"}
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          <label>
            Search strategies
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name or underlying"
            />
          </label>
        </div>
        <details className="strategy-refine">
          <summary>Market filter</summary>
          <label>
            Market
            <select
              aria-label="Strategy market filter"
              value={market}
              onChange={(event) => setMarket(event.target.value)}
            >
              <option value="all">All</option>
              <option value="cash">Cash</option>
              <option value="options">Spreads</option>
            </select>
          </label>
        </details>
        {library.error && (
          <div className="error" role="alert">
            <p>{library.error}</p>
            <Button
              disabled={library.loading}
              variant="secondary"
              onClick={library.refresh}
            >
              Retry saved strategies
            </Button>
          </div>
        )}
        {library.loading ? (
          <p role="status">Loading saved strategies…</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Underlying</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>P&amp;L</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((strategy) => (
                  <tr key={strategy.id}>
                    <td>
                      <strong>{strategy.definition.name}</strong>
                    </td>
                    <td>
                      {[
                        ...new Set(
                          strategy.definition.legs.map((leg) => leg.stockCode),
                        ),
                      ].join(", ")}
                    </td>
                    <td>
                      {strategy.definition.market === "options"
                        ? "Spread research"
                        : "Cash research"}
                    </td>
                    <td>
                      <span className="badge">Saved</span>
                    </td>
                    <td title="Available only in a completed backtest">—</td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          onOpenStrategy(
                            strategy.id,
                            strategy.definition.market,
                          )
                        }
                      >
                        Open →
                      </Button>
                    </td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={6}>
                      {library.error
                        ? "Saved strategies could not be loaded. This is not a confirmed empty library; retry the request."
                        : status !== "All" && status !== "Saved"
                          ? `${status} strategies are unavailable: this workspace stores research definitions, not deployed strategies. Unsaved drafts remain in their editor.`
                          : search || market !== "all"
                            ? "No strategies match these filters."
                            : "No saved strategies yet. Create a strategy to begin."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          {filtered.length} of {library.strategies.length} saved definitions.
          Returns are available only in completed historical reports.
        </p>
      </div>
      <div className="screen-two-columns">
        <article className="panel screen-card">
          <h2>Saved, not deployed</h2>
          <p>
            Research definitions never start live trading. Each backtest retains
            the definition used for that run.
          </p>
        </article>
        <article className="panel screen-card">
          <h2>You stay in control</h2>
          <p>
            Creating or editing a strategy does not change broker positions.
            Live orders require separate risk checks and confirmation.
          </p>
        </article>
      </div>
    </section>
  );
}
