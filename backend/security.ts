/** Shared security primitives: asynchronous password hashing, bounded request throttles
 * and purpose/account-bound encryption. Never import this server-only module into the frontend.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RequestHandler } from "express";
import { root } from "./database.js";

/** Hash high-entropy tokens for lookup/comparison; passwords use scrypt instead. */
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Compare fixed-length digests, avoiding length-dependent timing comparisons. */
export const equal = (a: unknown, b: unknown) =>
  timingSafeEqual(
    Buffer.from(digest(String(a))),
    Buffer.from(digest(String(b))),
  );
/** Throw an intentionally public HTTP error; callers must not include secrets in detail. */
export const fail = (status: number, detail: string): never => {
  throw Object.assign(new Error(detail), { status, detail });
};
/** Preserve the legacy scrypt format while moving expensive password work off the event loop. */
export async function passwordHash(
  password: string,
  salt = randomBytes(16).toString("hex"),
): Promise<string> {
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      Buffer.from(salt, "hex"),
      64,
      { N: 16384, r: 8, p: 1 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
  return `${salt}:${key.toString("hex")}`;
}

// Single API instance. A shared limiter is required before horizontal scaling.
export function rateLimit(
  limit: number,
  windowMs: number,
  key: (req: Parameters<RequestHandler>[0]) => string,
): RequestHandler {
  const buckets = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 5000)
      for (const [id, bucket] of buckets)
        if (bucket.until <= now) buckets.delete(id);
    const id = digest(key(req));
    let bucket = buckets.get(id);
    if (!bucket || bucket.until <= now) {
      if (!bucket && buckets.size >= 10000)
        return res
          .status(429)
          .json({ detail: "Server busy. Try again shortly." });
      bucket = { count: 0, until: now + windowMs };
      buckets.set(id, bucket);
    }
    if (++bucket.count > limit) {
      res.setHeader("Retry-After", Math.ceil((bucket.until - now) / 1000));
      return res
        .status(429)
        .json({ detail: "Too many requests. Try again shortly." });
    }
    next();
  };
}

/** Load the production key, or create a restricted local key without overwriting an existing one.
 * Encryption is AES-256-GCM with a fresh IV per record and user/purpose-specific associated data.
 */
export function credentialVault(env: NodeJS.ProcessEnv) {
  let hex = env.BROKER_ENCRYPTION_KEY;
  if (!hex) {
    if (env.APP_ENV === "production")
      throw new Error(
        "BROKER_ENCRYPTION_KEY must be 64 random hex characters.",
      );
    const directory = resolve(root, ".runtime"),
      path = resolve(directory, "broker.key");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      hex = readFileSync(path, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hex = randomBytes(32).toString("hex");
      try {
        writeFileSync(path, hex, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        hex = readFileSync(path, "utf8").trim();
      }
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(hex))
    throw new Error("BROKER_ENCRYPTION_KEY must be 64 random hex characters.");
  const key = Buffer.from(hex, "hex");
  return {
    /** Serialize and authenticate a secret, binding its ciphertext to its owning account/purpose. */
    seal(userId: string, value: unknown) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`breeze:v1:${userId}`));
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        encrypted.toString("base64"),
      ].join(".");
    },
    /** Authenticate before parsing; a changed key, record or account context fails closed. */
    open(userId: string, text: string): unknown {
      const [version, iv, tag, encrypted] = text.split(".");
      if (version !== "v1") throw new Error("Unsupported credential format.");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64"),
      );
      cipher.setAAD(Buffer.from(`breeze:v1:${userId}`));
      cipher.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          cipher.update(Buffer.from(encrypted, "base64")),
          cipher.final(),
        ]).toString("utf8"),
      );
    },
  };
}
