"use client";
/** Saved research definitions are independent of paper wallets and live execution permission. */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
  /** Recompute displayed rows only when the library or filters change. */
  const filtered = useMemo(
    () =>
      library.strategies.filter(
        (strategy) =>
          (market === "all" || strategy.definition.market === market) &&
          `${strategy.definition.name} ${strategy.definition.legs.map((leg) => leg.stockCode).join(" ")}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [library.strategies, search, market],
  );
  return (
    <section aria-label="Saved strategies" className="screen-stack">
      <div className="screen-toolbar">
        <p>Build, test and manage your trading ideas.</p>
        <Button onClick={() => onOpenStrategy("", "cash")}>New strategy</Button>
      </div>
      <div className="panel screen-card">
        <div className="screen-toolbar">
          <label>
            Search strategies
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name or underlying"
            />
          </label>
          <div
            className="screen-filters"
            role="group"
            aria-label="Strategy market filter"
          >
            {[
              ["all", "All"],
              ["cash", "Cash"],
              ["options", "Spreads"],
            ].map(([value, label]) => (
              <Button
                key={value}
                variant={market === value ? "primary" : "secondary"}
                aria-pressed={market === value}
                onClick={() => setMarket(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        {library.error && (
          <p className="error" role="alert">
            {library.error}
          </p>
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
                  <th>Type</th>
                  <th>Status</th>
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
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={5}>
                      {search || market !== "all"
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
