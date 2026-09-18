/** Validate the offline importer against real PostgreSQL without touching user data.
 * SQLite appears only here to represent the old file format being retired.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresTestStore } from "./postgres-fixture.mjs";
import { runDatabaseMigrations } from "../dist/backend/database.js";
import { importLegacySqlite } from "../dist/backend/import-legacy-sqlite.js";

test("legacy import preserves hashes/data, invalidates sessions and refuses reimport", async (t) => {
  const database = await createPostgresTestStore();
  t.after(() => database.close());
  await runDatabaseMigrations(database, {});
  const directory = mkdtempSync(join(tmpdir(), "nralgo-import-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "legacy.db");
  const source = new DatabaseSync(sourcePath);
  try {
    // Derive fixture column names from the fresh destination schema; no production file is read.
    const columns = await database.transaction((query) =>
      query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position",
      ),
    );
    for (const table of new Set(columns.map((column) => column.table_name))) {
      source.exec(
        `CREATE TABLE ${table} (${columns
          .filter((column) => column.table_name === table)
          .map((column) => column.column_name)
          .join(",")})`,
      );
    }
    source.exec("INSERT INTO schema_migrations VALUES(3)");
    source.exec(
      "INSERT INTO users VALUES('legacy-owner','legacy-user','original-password-hash')",
    );
    source.exec("INSERT INTO user_settings VALUES('legacy-owner',1)");
    source.exec(
      "INSERT INTO events VALUES(7,'Original event','2026-09-17','legacy-owner')",
    );
    source.exec(
      "INSERT INTO broker_credentials VALUES('legacy-owner','original-encrypted-value','2026-09-17')",
    );
    source.exec(
      "INSERT INTO sessions VALUES('old-cookie','old-csrf',9999999999999,'legacy-owner')",
    );
  } finally {
    source.close();
  }
  const originalBytes = readFileSync(sourcePath);
  const counts = await importLegacySqlite(sourcePath, database);
  assert.equal(counts.users, 1);
  await database.transaction(async (query) => {
    assert.equal(
      (await query("SELECT password_hash FROM users"))[0].password_hash,
      "original-password-hash",
    );
    assert.equal(
      (await query("SELECT halted FROM user_settings"))[0].halted,
      true,
    );
    assert.equal(
      (await query("SELECT ciphertext FROM broker_credentials"))[0].ciphertext,
      "original-encrypted-value",
    );
    assert.equal((await query("SELECT * FROM sessions")).length, 0);
    assert.equal(
      (
        await query(
          "INSERT INTO events(message,created_at,user_id) VALUES('After import','2026-09-17','legacy-owner') RETURNING id",
        )
      )[0].id,
      8,
    );
  });
  await assert.rejects(
    importLegacySqlite(sourcePath, database),
    /already contains/,
  );
  assert.deepEqual(readFileSync(sourcePath), originalBytes);
});

test("PostgreSQL transactions roll back failed writes", async (t) => {
  const database = await createPostgresTestStore();
  t.after(() => database.close());
  await runDatabaseMigrations(database, {});
  await assert.rejects(
    database.transaction(async (query) => {
      await query(
        "INSERT INTO users VALUES('rollback','rollback-user','hash')",
      );
      throw new Error("intentional failure");
    }),
    /intentional failure/,
  );
  assert.equal(
    (await database.transaction((query) => query("SELECT * FROM users")))
      .length,
    0,
  );
});
