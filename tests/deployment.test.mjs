/** Preflight fixtures contain generated, disposable secrets only; never load the real .env. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionEnvironmentErrors } from "../scripts/check-production-environment.mjs";

test("deployment preflight accepts scoped secrets and rejects unsafe configuration without leaking values", () => {
  const directory = mkdtempSync(join(tmpdir(), "nralgo-preflight-test-"));
  try {
    for (const name of [
      "app_database_password",
      "backup_database_password",
      "backup_encryption_key",
      "broker_encryption_key",
      "postgres_password",
      "setup_token",
      "registration_token",
      "calculation_service_token",
      "zerodha_api_key",
      "zerodha_api_secret",
      "spaces_access_key_id",
      "spaces_secret_access_key",
    ]) {
      writeFileSync(join(directory, name), randomBytes(32).toString("hex"), {
        mode: 0o444,
      });
    }
    const env = {
      SECRETS_DIR: directory,
      APP_DOMAIN: "terminal.invalid",
      ALLOW_PUBLIC_REGISTRATION: "false",
      KOTAK_STATIC_IP_CONFIRMED: "false",
      ZERODHA_STATIC_IP_CONFIRMED: "false",
      LIVE_TRADING_ENABLED: "false",
      MARKET_DATA_PROVIDER: "kotak",
      BACKUP_S3_URI: "s3://fixture-only/backups",
      BACKUP_S3_ENDPOINT: "https://blr1.digitaloceanspaces.com",
      BACKUP_S3_REGION: "blr1",
      ALERT_WEBHOOK_URL: "https://alerts.invalid/fixture",
    };
    for (const name of [
      "BACKEND",
      "WEB",
      "CALCULATION",
      "BACKUP",
      "MARKET_DATA",
      "POSTGRES",
      "CADDY",
    ]) {
      env[`${name}_IMAGE`] = `fixture@sha256:${"a".repeat(64)}`;
    }
    assert.deepEqual(productionEnvironmentErrors(env, null), []);
    const credentialUrl = new URL("https://alerts.invalid");
    credentialUrl.username = "user";
    credentialUrl.password = "secret";
    for (const url of [
      "",
      "not a url",
      "http://alerts.invalid",
      credentialUrl.href,
    ]) {
      const errors = productionEnvironmentErrors(
        { ...env, ALERT_WEBHOOK_URL: url },
        null,
      );
      assert.ok(errors.some((error) => error.startsWith("ALERT_WEBHOOK_URL")));
      assert.ok(!errors.join().includes("user:secret"));
    }
    assert.ok(
      productionEnvironmentErrors(
        { ...env, MARKET_DATA_IMAGE: "fixture:latest" },
        null,
      ).some((error) => error.startsWith("MARKET_DATA_IMAGE")),
    );
    assert.ok(
      productionEnvironmentErrors(
        { ...env, LIVE_TRADING_ENABLED: "true" },
        null,
      ).some((error) => error.startsWith("Live execution")),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
