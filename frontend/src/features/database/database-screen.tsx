"use client";
/** Live, owner-scoped table browser. This is intentionally not a raw SQL console. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageActions } from "@/features/workspace/workspace-views";
import { requestApiJson } from "@/lib/api";

type DatabaseResponse = {
  table: string;
  description: string;
  rows: Array<Record<string, unknown>>;
  refreshedAt: string;
  limit: number;
  tables: Array<{ name: string; description: string }>;
};

function cell(value: unknown) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  const text = String(value ?? "");
  try {
    return text.startsWith("{") || text.startsWith("[")
      ? JSON.stringify(JSON.parse(text))
      : text;
  } catch {
    return text;
  }
}

export function DatabaseScreen() {
  const [selectedTable, setSelectedTable] = useState("events");
  const [data, setData] = useState<DatabaseResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const result = (await requestApiJson(
        `/database?table=${encodeURIComponent(selectedTable)}`,
      )) as DatabaseResponse;
      setData(result);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Database data unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, [selectedTable]);
  useEffect(() => {
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);
  const columns = useMemo(
    () =>
      Array.from(new Set(data?.rows.flatMap((row) => Object.keys(row)) ?? [])),
    [data],
  );
  return (
    <section className="screen-stack database-screen">
      <PageActions>
        <span className="database-live" role="status">
          <i /> Live updates every 3 seconds
        </span>
        <Button
          variant="secondary"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={15} aria-hidden="true" />{" "}
          {loading ? "Loading…" : "Refresh now"}
        </Button>
      </PageActions>
      <section className="panel screen-card database-browser">
        <div className="database-toolbar">
          <label>
            <span>Table</span>
            <select
              value={selectedTable}
              onChange={(event) => setSelectedTable(event.target.value)}
            >
              {(
                data?.tables ?? [
                  {
                    name: "events",
                    description: "Your workspace activity history.",
                  },
                ]
              ).map((table) => (
                <option key={table.name} value={table.name}>
                  {table.name}
                </option>
              ))}
            </select>
          </label>
          <p>{data?.description ?? "Loading your workspace data…"}</p>
        </div>
        <p className="database-notice">
          This viewer is restricted to your own non-sensitive data. Use the
          relevant workspace screen to change records safely.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="database-meta">
          <span>
            {data?.rows.length ?? 0} rows shown (maximum {data?.limit ?? 100})
          </span>
          {data ? (
            <time dateTime={data.refreshedAt}>
              Last checked {new Date(data.refreshedAt).toLocaleTimeString()}
            </time>
          ) : null}
        </div>
        <div className="database-table-wrap" aria-busy={loading}>
          <table className="database-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row, index) => (
                <tr key={`${String(row.id ?? index)}`}>
                  {columns.map((column) => (
                    <td key={column} title={cell(row[column])}>
                      {cell(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && data && !data.rows.length ? (
            <p className="database-empty">
              No rows in this table for this workspace.
            </p>
          ) : null}
        </div>
      </section>
    </section>
  );
}
