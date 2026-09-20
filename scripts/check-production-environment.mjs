/**
 * Fail-closed production deployment preflight.
 * It validates shape and separation only; secret values are never printed.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const booleanNames = [
  "ALLOW_PUBLIC_REGISTRATION",
  "KOTAK_STATIC_IP_CONFIRMED",
  "ZERODHA_STATIC_IP_CONFIRMED",
  "LIVE_TRADING_ENABLED",
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
  env = { ...env };
  const secretNames = [
    ...hexSecretNames,
    "POSTGRES_PASSWORD",
    "SETUP_TOKEN",
    "REGISTRATION_TOKEN",
    "CALCULATION_SERVICE_TOKEN",
    "ZERODHA_API_KEY",
    "ZERODHA_API_SECRET",
    "SPACES_ACCESS_KEY_ID",
    "SPACES_SECRET_ACCESS_KEY",
  ];
  try {
    const directory = env.SECRETS_DIR || "";
    const info = lstatSync(directory);
    if (
      !isAbsolute(directory) ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077
    ) {
      throw new Error("Secret directory must be absolute and owner-only");
    }
    for (const name of secretNames) {
      if (env[name]) {
        errors.push(`${name} must be file-mounted, not stored in .env.`);
      }
      const file = resolve(directory, name.toLowerCase());
      const metadata = lstatSync(file);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.mode & 0o022 ||
        metadata.size > 8192
      ) {
        throw new Error("Invalid secret file permissions or size");
      }
      env[name] = readFileSync(file, "utf8").trim();
      if (env[name].includes("\n")) {
        throw new Error("Invalid secret content");
      }
    }
  } catch {
    errors.push(
      "SECRETS_DIR must contain all scoped secret files in a private 0700 directory; files must not be writable by group/others.",
    );
  }
  for (const name of [
    "BACKEND_IMAGE",
    "WEB_IMAGE",
    "CALCULATION_IMAGE",
    "BACKUP_IMAGE",
    "MARKET_DATA_IMAGE",
    "POSTGRES_IMAGE",
    "CADDY_IMAGE",
  ]) {
    if (!/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(env[name] || "")) {
      errors.push(
        `${name} must be an immutable image reference from .env.release.`,
      );
    }
  }
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
    env.KOTAK_STATIC_IP_CONFIRMED !== "true" &&
    env.ZERODHA_STATIC_IP_CONFIRMED !== "true"
  ) {
    errors.push(
      "Live execution requires static-IP registration for at least one supported broker; each active provider is gated separately.",
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
  const s3Endpoint = required("BACKUP_S3_ENDPOINT");
  const spacesRegion = required("BACKUP_S3_REGION");
  if (
    s3Endpoint &&
    s3Endpoint !== `https://${spacesRegion}.digitaloceanspaces.com`
  ) {
    errors.push(
      "BACKUP_S3_ENDPOINT must match the selected DigitalOcean Spaces region.",
    );
  }
  if (spacesRegion !== "blr1") {
    errors.push("BACKUP_S3_REGION must be blr1 for the India deployment.");
  }
  const webhookUrl = required("ALERT_WEBHOOK_URL");
  try {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Invalid webhook");
    }
  } catch {
    errors.push("ALERT_WEBHOOK_URL must be an https:// URL.");
  }
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
  if (!/^[A-Za-z0-9]{10,128}$/.test(required("SPACES_ACCESS_KEY_ID"))) {
    errors.push("SPACES_ACCESS_KEY_ID is malformed.");
  }
  if (!/^\S{20,256}$/.test(required("SPACES_SECRET_ACCESS_KEY"))) {
    errors.push("SPACES_SECRET_ACCESS_KEY is malformed.");
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
