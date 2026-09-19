/** Read explicitly mounted secrets before the entrypoint imports application code.
 * Used with node --import; Docker metadata holds file paths, never secret values.
 * Secrets are scoped by each service's mounts. Nothing is fetched from AWS here.
 */
import { readFileSync } from "node:fs";

for (const name of [
  "DB_PASSWORD",
  "APP_DATABASE_PASSWORD",
  "BACKUP_DATABASE_PASSWORD",
  "SETUP_TOKEN",
  "REGISTRATION_TOKEN",
  "BROKER_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "CALCULATION_SERVICE_TOKEN",
  "ZERODHA_API_KEY",
  "ZERODHA_API_SECRET",
  "ALERT_WEBHOOK_URL",
]) {
  const path = process.env[`${name}_FILE`];
  if (!path) {
    continue;
  }
  if (process.env[name]) {
    throw new Error(`Supply only ${name}_FILE, not both secret sources.`);
  }
  if (!path.startsWith("/run/secrets/")) {
    throw new Error(`${name}_FILE must be a mounted secret.`);
  }
  try {
    const value = readFileSync(path, "utf8").trim();
    if (value.length > 8192 || value.includes("\n")) {
      throw new Error("Invalid secret");
    }
    process.env[name] = value;
  } catch {
    throw new Error(`Unable to read mounted ${name}.`);
  }
}

if (process.env.DB_PASSWORD) {
  if (process.env.DATABASE_URL) {
    throw new Error("Supply only one database credential source.");
  }
  const { DB_USER, DB_HOST = "db", DB_NAME = "nexus" } = process.env;
  if (
    !DB_USER ||
    ![DB_USER, DB_HOST, DB_NAME].every((value) => /^[a-z0-9_-]+$/i.test(value))
  ) {
    throw new Error("Invalid private database identity.");
  }
  process.env.DATABASE_URL = `postgresql://${DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@${DB_HOST}:5432/${DB_NAME}`;
  delete process.env.DB_PASSWORD;
}
