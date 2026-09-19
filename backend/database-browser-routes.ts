/** Owner-scoped database browser. It deliberately exposes data records, not database access. */
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./database.js";

const tables = [
  "strategies",
  "jobs",
  "events",
  "research_strategies",
  "research_runs",
  "live_accounts",
  "live_orders",
  "live_spreads",
  "live_events",
] as const;
type BrowserTable = (typeof tables)[number];

const tableInput = z.enum(tables).default("events");
const descriptions: Record<BrowserTable, string> = {
  strategies: "Saved legacy strategies.",
  jobs: "Legacy replay jobs.",
  events: "Your workspace activity history.",
  research_strategies: "Saved research strategy definitions.",
  research_runs: "Historical research run summaries.",
  live_accounts: "Configured live account state.",
  live_orders:
    "Live order records; changes should be made through Live positions.",
  live_spreads: "Live multi-leg order records.",
  live_events: "Live trading audit records.",
};

/** Register after the application authentication and CSRF middleware. No schema, credential or
 * session table is ever selectable. Every query keeps the authenticated user as its scope. */
export function registerDatabaseBrowserRoutes(app: Express, store: Store) {
  app.get("/api/database", async (req, res) => {
    const table = tableInput.parse(req.query.table);
    const userId = res.locals.session.user_id;
    const rows = await store.transaction(async (query) => {
      switch (table) {
        case "live_orders":
          return query(
            "SELECT o.id,o.broker_id,o.intent_key,o.state,o.reserved_paise,o.created_at,o.intent,o.broker_order FROM live_orders o JOIN live_accounts a ON a.id=o.account_id WHERE a.user_id=$1 ORDER BY o.created_at DESC LIMIT 100",
            [userId],
          );
        case "live_spreads":
          return query(
            "SELECT s.id,s.state,s.detail,s.plan FROM live_spreads s JOIN live_accounts a ON a.id=s.account_id WHERE a.user_id=$1 LIMIT 100",
            [userId],
          );
        case "live_events":
          return query(
            "SELECT e.id,e.kind,e.detail,e.created_at FROM live_events e JOIN live_accounts a ON a.id=e.account_id WHERE a.user_id=$1 ORDER BY e.created_at DESC LIMIT 100",
            [userId],
          );
        case "live_accounts":
          return query(
            "SELECT id,broker_binding,halted,halt_reason,generation,snapshot,limits,reconciled_at FROM live_accounts WHERE user_id=$1 ORDER BY reconciled_at DESC LIMIT 100",
            [userId],
          );
        default:
          // These tables have a direct user_id column. The allowlist above keeps table names
          // constant, so no user-controlled identifier reaches SQL.
          return query(
            `SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1 DESC LIMIT 100`,
            [userId],
          );
      }
    });
    res.json({
      table,
      description: descriptions[table],
      rows,
      refreshedAt: new Date().toISOString(),
      limit: 100,
      tables: tables.map((name) => ({ name, description: descriptions[name] })),
    });
  });
}
