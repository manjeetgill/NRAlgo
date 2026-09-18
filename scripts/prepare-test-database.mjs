/**
 * Prepare one database server before Node starts parallel backend test workers.
 * CI supplies an isolated TEST_DATABASE_URL; local runs reuse the project-owned cluster.
 */
if (!process.env.TEST_DATABASE_URL) {
  const { ensureLocalPostgres } =
    await import("../dist/backend/local-database.js");
  await ensureLocalPostgres();
}
