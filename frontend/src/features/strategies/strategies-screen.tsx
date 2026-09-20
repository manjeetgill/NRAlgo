"use client";
/** Saved research definitions are independent of live execution permission. */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PageActions } from "@/features/workspace/workspace-views";
import {
  useStrategyLibrary,
  type SavedResearchSummary,
} from "./use-strategy-library";

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
  const columns: DataTableColumn<SavedResearchSummary>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (strategy) => strategy.definition.name,
      render: (strategy) => <strong>{strategy.definition.name}</strong>,
    },
    {
      key: "underlying",
      header: "Underlying",
      render: (strategy) =>
        [...new Set(strategy.definition.legs.map((leg) => leg.stockCode))].join(
          ", ",
        ),
    },
    {
      key: "mode",
      header: "Mode",
      render: (strategy) =>
        strategy.definition.market === "options"
          ? "Spread research"
          : "Cash research",
    },
    {
      key: "status",
      header: "Status",
      render: () => <Badge tone="success">Saved</Badge>,
    },
    {
      key: "action",
      header: "Action",
      render: (strategy) => (
        <Button
          variant="ghost"
          onClick={() =>
            onOpenStrategy(strategy.id, strategy.definition.market)
          }
        >
          Open research →
        </Button>
      ),
    },
  ];
  return (
    <section
      aria-label="Saved strategies"
      className="screen-stack strategies-screen"
    >
      <PageActions>
        <Button onClick={() => onOpenStrategy("", "cash")}>
          New cash strategy
        </Button>
        <Button
          variant="secondary"
          onClick={() => onOpenStrategy("", "options")}
        >
          Build option spread
        </Button>
      </PageActions>
      <div className="panel screen-card">
        <div className="screen-toolbar strategy-toolbar">
          <Field label="Search strategies" htmlFor="strategies-search">
            <Input
              id="strategies-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name or underlying"
            />
          </Field>
        </div>
        <details className="strategy-refine">
          <summary>Market filter</summary>
          <Field label="Market" htmlFor="strategies-market-filter">
            <Select
              id="strategies-market-filter"
              aria-label="Strategy market filter"
              value={market}
              onChange={(event) => setMarket(event.target.value)}
            >
              <option value="all">All</option>
              <option value="cash">Cash</option>
              <option value="options">Spreads</option>
            </Select>
          </Field>
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
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(strategy) => strategy.id}
            emptyTitle={
              library.error
                ? "Saved strategies could not be loaded"
                : search || market !== "all"
                  ? "No strategies match these filters"
                  : "No saved strategies yet"
            }
            emptyDescription={
              library.error
                ? "This is not a confirmed empty library; retry the request."
                : search || market !== "all"
                  ? undefined
                  : "Create a strategy to begin."
            }
          />
        )}
        <p className="muted">
          {filtered.length} of {library.strategies.length} saved definitions.
          Returns are available only in completed historical reports.
        </p>
      </div>
      <p className="muted">
        Saved definitions are research, not deployed strategies. Live orders
        require separate authorization.
      </p>
    </section>
  );
}
