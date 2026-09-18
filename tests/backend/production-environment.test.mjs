/** Production preflight regression tests: unsafe configuration must fail before deployment. */
import assert from "node:assert/strict";
import test from "node:test";
import { productionEnvironmentErrors } from "../../scripts/check-production-environment.mjs";

const safeEnvironment = {
  APP_DOMAIN: "trade.nrialgo.in",
  ALLOW_PUBLIC_REGISTRATION: "false",
  KOTAK_STATIC_IP_CONFIRMED: "false",
  LIVE_TRADING_ENABLED: "false",
  PAPER_TRADING_ENABLED: "false",
  MARKET_DATA_PROVIDER: "kotak",
  POSTGRES_PASSWORD: "database_admin_password_1234567890",
  APP_DATABASE_PASSWORD: "a".repeat(64),
  BACKUP_DATABASE_PASSWORD: "b".repeat(64),
  SETUP_TOKEN: "setup-token-that-is-long-and-unique",
  BROKER_ENCRYPTION_KEY: "c".repeat(64),
  BACKUP_ENCRYPTION_KEY: "d".repeat(64),
  REGISTRATION_TOKEN: "registration-token-long-and-unique",
  BACKUP_S3_URI: "s3://private-nrialgo-backups/production",
};

test("production preflight accepts separated secrets and closed registration", () => {
  assert.deepEqual(productionEnvironmentErrors(safeEnvironment, null), []);
});

test("production preflight rejects public signup, reused secrets and unconfirmed live execution", () => {
  const unsafe = {
    ...safeEnvironment,
    ALLOW_PUBLIC_REGISTRATION: "true",
    LIVE_TRADING_ENABLED: "true",
    APP_DATABASE_PASSWORD: "c".repeat(64),
    BACKUP_S3_URI: "https://public.example/backups",
  };
  const errors = productionEnvironmentErrors(unsafe, null);
  assert.ok(errors.some((error) => error.includes("must remain false")));
  assert.ok(errors.some((error) => error.includes("static-IP")));
  assert.ok(errors.some((error) => error.includes("must be unique")));
  assert.ok(errors.some((error) => error.includes("s3://")));
});
