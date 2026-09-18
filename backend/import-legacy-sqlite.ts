/** One-time, offline migration from the previous SQLite v3 workspace to PostgreSQL.
 * This module is never imported by the application. The source is opened read-only,
 * the destination must be empty, and all account data moves in one transaction.
 * Login sessions and worker leases are deliberately not copied. Preserve broker.key.
 */
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { isEntryPoint, openDatabaseStore, type Store } from "./database.js";
import { readLocalPostgresConfiguration } from "./local-database.js";

// Fixed identifiers prevent either the source file or CLI input from injecting SQL names.
const tables = {
  users: ["id", "username", "password_hash"],
  user_settings: ["user_id", "halted"],
  strategies: [
    "id",
    "name",
    "symbol",
    "fast",
    "slow",
    "capital",
    "status",
    "pnl",
    "created_at",
    "user_id",
  ],
  jobs: [
    "id",
    "strategy_id",
    "status",
    "result",
    "created_at",
    "updated_at",
    "user_id",
  ],
  events: ["id", "message", "created_at", "user_id"],
  broker_credentials: ["user_id", "ciphertext", "updated_at"],
  user_security: [
    "user_id",
    "encrypted_secret",
    "enabled",
    "last_counter",
    "recovery_hashes",
    "pending_expires",
  ],
  broker_usage: ["user_id", "usage_day", "request_count"],
} as const;

/** Import a stopped, schema-v3 workspace. Refuse populated targets; never reset passwords
 * or decrypt/re-encrypt broker secrets. A failed row rolls back the entire import.
 */
export async function importLegacySqlite(
  sourcePath: string,
  destination: Store,
) {
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  try {
    const versions = source
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    if (versions.at(-1)?.version !== 3)
      throw new Error(
        "Only the previous schema-v3 workspace can be imported. Keep older backups untouched.",
      );
    return await destination.transaction(async (query) => {
      await query("SELECT pg_advisory_xact_lock(684201)");
      await query(
        "LOCK TABLE users,user_settings,strategies,jobs,events,broker_credentials,user_security,broker_usage,sessions IN ACCESS EXCLUSIVE MODE",
      );
      for (const table of [...Object.keys(tables), "sessions"]) {
        if ((await query(`SELECT 1 FROM ${table} LIMIT 1`)).length)
          throw new Error(
            "Import refused: destination already contains account data.",
          );
      }
      const counts: Record<string, number> = {};
      for (const [table, columns] of Object.entries(tables)) {
        const rows = source
          .prepare(`SELECT ${columns.join(",")} FROM ${table}`)
          .all();
        for (const row of rows) {
          const values = columns.map((column) => {
            const value = row[column];
            if (column === "halted" || column === "enabled")
              return Boolean(value);
            if (
              value === null ||
              typeof value === "string" ||
              typeof value === "number"
            )
              return value;
            throw new Error(`Unsupported value in ${table}.${column}`);
          });
          await query(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
            values,
          );
        }
        counts[table] = rows.length;
      }
      await query(
        "SELECT setval(pg_get_serial_sequence('events','id'),COALESCE((SELECT MAX(id) FROM events),1),(SELECT COUNT(*)>0 FROM events))",
      );
      return counts;
    });
  } finally {
    source.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  if (!process.argv[2])
    throw new Error(
      "Usage: node --import tsx backend/import-legacy-sqlite.ts /absolute/path/to/workspace.db (stop the app first)",
    );
  const database = openDatabaseStore(
    process.env.MIGRATION_DATABASE_URL ||
      readLocalPostgresConfiguration()?.adminUrl,
  );
  try {
    console.log(
      "Imported row counts (old sessions invalidated):",
      await importLegacySqlite(process.argv[2], database),
    );
  } finally {
    await database.close();
  }
}
