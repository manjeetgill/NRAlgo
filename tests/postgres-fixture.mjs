/** Allocate a unique PostgreSQL schema for each test. Tests use the real database engine,
 * never the application schema. Cleanup drops only the random schema created by this helper.
 * CI supplies TEST_DATABASE_URL; local runs use the project-owned PostgreSQL admin connection.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureLocalPostgres } from "../dist/backend/local-database.js";
import { openDatabaseStore } from "../dist/backend/database.js";

let localConfiguration;
/** Create and later destroy one schema with its own pool/search_path, preserving all real user data. */
export async function createPostgresTestStore() {
  const url =
    process.env.TEST_DATABASE_URL ||
    (localConfiguration ||= await ensureLocalPostgres()).adminUrl;
  const schema = `nralgo_test_${randomUUID().replaceAll("-", "")}`;
  const administrator = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  await administrator.connect();
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const database = openDatabaseStore(scopedUrl.toString());
  const closePool = database.close.bind(database);
  database.close = async () => {
    try {
      await closePool();
      await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await administrator.end();
    }
  };
  return database;
}
