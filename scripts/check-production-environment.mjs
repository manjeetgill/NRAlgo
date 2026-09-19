/**
 * Fail-closed production deployment preflight.
 * It validates shape and separation only; secret values are never printed.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const booleanNames = [
  "ALLOW_PUBLIC_REGISTRATION",
  "KOTAK_STATIC_IP_CONFIRMED",
  "LIVE_TRADING_ENABLED",
  "PAPER_TRADING_ENABLED",
];
const hexSecretNames = [
  "APP_DATABASE_PASSWORD",
  "BACKUP_DATABASE_PASSWORD",
  "BACKUP_ENCRYPTION_KEY",
  "BROKER_ENCRYPTION_KEY",
];

/** Collect every unsafe production setting without disclosing its value. */
export function productionEnvironmentErrors(env, envPath = ".env") {
  const errors = [];
  const required = (name) => {
    const value = env[name]?.trim() || "";
    if (!value) {
      errors.push(`${name} is required.`);
    }
    return value;
  };
  const domain = required("APP_DOMAIN");
  if (domain) {
    try {
      const url = new URL(`https://${domain}`);
      if (
        url.hostname !== domain ||
        url.port ||
        url.pathname !== "/" ||
        !domain.includes(".") ||
        domain === "localhost" ||
        domain.endsWith(".local") ||
        domain.includes("example")
      ) {
        throw new Error("not a public deployment hostname");
      }
    } catch {
      errors.push(
        "APP_DOMAIN must be a real public hostname without a scheme or path.",
      );
    }
  }

  for (const name of booleanNames) {
    if (!["true", "false"].includes(env[name] || "")) {
      errors.push(`${name} must be exactly true or false.`);
    }
  }
  if (env.ALLOW_PUBLIC_REGISTRATION !== "false") {
    errors.push(
      "ALLOW_PUBLIC_REGISTRATION must remain false for this deployment profile.",
    );
  }
  if (
    env.LIVE_TRADING_ENABLED === "true" &&
    env.KOTAK_STATIC_IP_CONFIRMED !== "true"
  ) {
    errors.push(
      "Live execution requires confirmed Kotak static-IP registration.",
    );
  }
  if ((env.MARKET_DATA_PROVIDER || "") !== "kotak") {
    errors.push(
      "MARKET_DATA_PROVIDER must be kotak until another provider is implemented.",
    );
  }

  const postgresPassword = required("POSTGRES_PASSWORD");
  if (postgresPassword && !/^[A-Za-z0-9_-]{32,128}$/.test(postgresPassword)) {
    errors.push("POSTGRES_PASSWORD must be 32-128 URL-safe characters.");
  }
  for (const name of hexSecretNames) {
    if (!/^[a-fA-F0-9]{64}$/.test(required(name))) {
      errors.push(`${name} must contain exactly 64 hexadecimal characters.`);
    }
  }
  for (const name of ["SETUP_TOKEN", "REGISTRATION_TOKEN"]) {
    const value =
      name === "REGISTRATION_TOKEN" ? env[name]?.trim() || "" : required(name);
    if (value && value.length < 32) {
      errors.push(`${name} must contain at least 32 characters.`);
    }
  }
  const calculationToken = required("CALCULATION_SERVICE_TOKEN");
  if (calculationToken && calculationToken.length < 32) {
    errors.push(
      "CALCULATION_SERVICE_TOKEN must contain at least 32 characters.",
    );
  }
  const secrets = [
    "POSTGRES_PASSWORD",
    "APP_DATABASE_PASSWORD",
    "BACKUP_DATABASE_PASSWORD",
    "SETUP_TOKEN",
    "BROKER_ENCRYPTION_KEY",
    "BACKUP_ENCRYPTION_KEY",
    "REGISTRATION_TOKEN",
    "CALCULATION_SERVICE_TOKEN",
  ].filter((name) => env[name]);
  if (new Set(secrets.map((name) => env[name])).size !== secrets.length) {
    errors.push(
      "Every database, setup, registration and encryption secret must be unique.",
    );
  }

  const backupUri = required("BACKUP_S3_URI");
  if (backupUri) {
    try {
      const url = new URL(backupUri);
      if (
        url.protocol !== "s3:" ||
        !url.hostname ||
        url.username ||
        url.password
      ) {
        throw new Error("invalid backup destination");
      }
    } catch {
      errors.push("BACKUP_S3_URI must be a private s3:// bucket destination.");
    }
  }
  if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY)) {
    errors.push(
      "Supply both AWS access-key fields or neither when using an instance role.",
    );
  }

  try {
    if (envPath && (statSync(resolve(envPath)).mode & 0o077) !== 0) {
      errors.push(
        ".env must be readable and writable only by its owner (mode 0600).",
      );
    }
  } catch {
    if (envPath) {
      errors.push("A private .env file is required.");
    }
  }
  return errors;
}

/** Print only setting names/reasons and exit before Docker sees an unsafe configuration. */
function run() {
  const errors = productionEnvironmentErrors(process.env);
  if (errors.length) {
    console.error("Production preflight failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Production environment preflight passed.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run();
}
