/** Authenticator-app MFA and one-use recovery codes for application accounts, not broker login.
 * Secrets use the same AES-GCM vault with a separate purpose-bound encryption context.
 * Call verification while holding the user's settings lock so concurrent requests cannot reuse a code.
 */
import { Secret, TOTP } from "otpauth";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Express } from "express";
import {
  audit,
  lockWorkspaceSettings,
  type Query,
  type Store,
} from "./database.js";
import {
  credentialVault,
  digest,
  equal,
  fail,
  passwordHash,
  rateLimit,
} from "./security.js";

type Vault = ReturnType<typeof credentialVault>;
/** Only proof failures affect lockout; outages and downstream business errors do not. */
class MfaProofError extends Error {}

/** Persist failed guesses even when the protected action rolls back. The settings
 * lock serializes all proof paths, and the savepoint prevents partial action writes.
 * Five failures lock MFA actions for 15 minutes, across sessions and API restarts.
 */
export async function withMfaAttempt<T>(
  store: Store,
  userId: string,
  action: (query: Query) => Promise<T>,
): Promise<T> {
  const outcome = await store.transaction(async (query) => {
    await lockWorkspaceSettings(query, store, userId);
    const [guard] = await query<{
      mfa_failures: number;
      mfa_locked_until: number;
    }>(
      "SELECT mfa_failures,mfa_locked_until FROM user_settings WHERE user_id=$1",
      [userId],
    );
    if (Number(guard.mfa_locked_until) > Date.now()) {
      fail(429, "Too many incorrect MFA codes. Try again after 15 minutes.");
    }
    await query("SAVEPOINT mfa_action");
    try {
      const value = await action(query);
      await query(
        "UPDATE user_settings SET mfa_failures=0,mfa_locked_until=0 WHERE user_id=$1",
        [userId],
      );
      return { ok: true as const, value };
    } catch (error) {
      if (!(error instanceof MfaProofError)) {
        throw error;
      }
      await query("ROLLBACK TO SAVEPOINT mfa_action");
      const failures =
        (Number(guard.mfa_locked_until) > 0 ? 0 : guard.mfa_failures) + 1;
      await query(
        "UPDATE user_settings SET mfa_failures=$2,mfa_locked_until=$3 WHERE user_id=$1",
        [userId, failures, failures >= 5 ? Date.now() + 15 * 60000 : 0],
      );
      return { ok: false as const };
    }
  });
  if (outcome.ok) {
    return outcome.value;
  }
  return fail(401, "Enter a fresh authenticator code or unused recovery code.");
}
interface SecurityRecord {
  encrypted_secret: string;
  enabled: boolean | number;
  last_counter: number;
  recovery_hashes: string;
  pending_expires: number;
}
/** Create the standards-based verifier. A 30-second period and six digits work with common authenticators. */
function authenticator(secret: string, username = "Account") {
  return new TOTP({
    issuer: "NRIAlgo",
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
}

/** Consume a valid TOTP/recovery code once, or reject without revealing the secret or valid code. */
export async function verifySecondFactor(
  query: Query,
  vault: Vault,
  userId: string,
  token: string,
) {
  const [record] = await query<SecurityRecord>(
    "SELECT * FROM user_security WHERE user_id=$1",
    [userId],
  );
  if (!record?.enabled) {
    return;
  }
  const recovery = JSON.parse(record.recovery_hashes) as string[];
  const recoveryIndex = recovery.findIndex((hash) =>
    equal(hash, digest(token)),
  );
  if (recoveryIndex >= 0) {
    recovery.splice(recoveryIndex, 1);
    await query(
      "UPDATE user_security SET recovery_hashes=$1 WHERE user_id=$2",
      [JSON.stringify(recovery), userId],
    );
    return;
  }
  const secret = z
    .string()
    .parse(vault.open(`${userId}:mfa`, record.encrypted_secret));
  const verificationTime = Date.now();
  const verifier = authenticator(secret),
    delta = verifier.validate({
      token,
      window: 1,
      timestamp: verificationTime,
    });
  const counter = Math.floor(verificationTime / 30000) + (delta || 0);
  if (delta === null || counter <= Number(record.last_counter)) {
    throw new MfaProofError("Invalid or reused MFA proof");
  }
  await query("UPDATE user_security SET last_counter=$1 WHERE user_id=$2", [
    counter,
    userId,
  ]);
}

/** Register authenticated, CSRF-protected MFA enrollment and removal endpoints. */
export function registerMfaRoutes(
  app: Express,
  store: Store,
  vault: Vault,
  disconnectBroker: (userId: string) => void | Promise<void>,
) {
  const proofAttemptLimit = rateLimit(
    10,
    60000,
    (req) => req.res!.locals.session.user_id,
  );
  /** Status reads retain the workspace read limit without consuming MFA proof attempts. */
  app.use("/api/auth/mfa", (req, res, next) => {
    if (req.method === "GET") {
      next();
      return;
    }
    proofAttemptLimit(req, res, next);
  });
  const proof = z.object({
    password: z.string().min(1).max(128),
    token: z.string().max(32).default(""),
  });
  /** Verify the current password before allowing changes to authentication factors. */
  async function requireCurrentPassword(userId: string, password: string) {
    const [user] = await store.transaction((query) =>
      query<{ password_hash: string; username: string }>(
        "SELECT password_hash,username FROM users WHERE id=$1",
        [userId],
      ),
    );
    if (
      !equal(
        await passwordHash(password, user.password_hash.split(":")[0]),
        user.password_hash,
      )
    ) {
      fail(403, "Current password is incorrect.");
    }
    return user;
  }
  app.get("/api/auth/mfa", async (req, res) => {
    const [record] = await store.transaction((query) =>
      query<SecurityRecord>(
        "SELECT enabled FROM user_security WHERE user_id=$1",
        [res.locals.session.user_id],
      ),
    );
    res.json({ enabled: Boolean(record?.enabled) });
  });
  app.post("/api/auth/mfa/setup", async (req, res) => {
    const userId = res.locals.session.user_id,
      data = proof.parse(req.body);
    const user = await requireCurrentPassword(userId, data.password),
      secret = new Secret({ size: 20 }).base32;
    await store.transaction(async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      const [currentUser] = await query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id=$1",
        [userId],
      );
      if (!equal(currentUser.password_hash, user.password_hash)) {
        fail(409, "Password changed. Sign in again.");
      }
      const [record] = await query<SecurityRecord>(
        "SELECT enabled FROM user_security WHERE user_id=$1",
        [userId],
      );
      if (record?.enabled) {
        fail(409, "MFA is already enabled.");
      }
      await query(
        "INSERT INTO user_security VALUES ($1,$2,$3,-1,$4,$5) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=$2,pending_expires=$5",
        [
          userId,
          vault.seal(`${userId}:mfa`, secret),
          false,
          "[]",
          Date.now() + 600000,
        ],
      );
    });
    // Deliberately returned once for manual entry into the user's authenticator; never logged.
    res.json({ secret, uri: authenticator(secret, user.username).toString() });
  });
  app.post("/api/auth/mfa/confirm", async (req, res) => {
    const userId = res.locals.session.user_id,
      token = z
        .string()
        .regex(/^\d{6}$/)
        .parse(req.body?.token);
    const recoveryCodes = Array.from({ length: 8 }, () =>
      randomBytes(12).toString("hex"),
    );
    await withMfaAttempt(store, userId, async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      const [record] = await query<SecurityRecord>(
        "SELECT * FROM user_security WHERE user_id=$1",
        [userId],
      );
      if (!record || record.enabled || record.pending_expires < Date.now()) {
        fail(409, "Start a new MFA setup.");
      }
      const verifier = authenticator(
        z.string().parse(vault.open(`${userId}:mfa`, record.encrypted_secret)),
      );
      const verificationTime = Date.now();
      const delta = verifier.validate({
        token,
        window: 1,
        timestamp: verificationTime,
      });
      if (delta === null) {
        throw new MfaProofError("Invalid enrollment proof");
      }
      await query(
        "UPDATE user_security SET enabled=$1,last_counter=$2,recovery_hashes=$3,pending_expires=0 WHERE user_id=$4",
        [
          true,
          Math.floor(verificationTime / 30000) + (delta || 0),
          JSON.stringify(recoveryCodes.map(digest)),
          userId,
        ],
      );
      await query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [
        userId,
        res.locals.session.token_hash,
      ]);
      await audit(
        query,
        "Authenticator MFA enabled; other app sessions revoked.",
        userId,
      );
    });
    await disconnectBroker(userId);
    res.json({ enabled: true, recovery_codes: recoveryCodes });
  });
  app.post("/api/auth/mfa/disable", async (req, res) => {
    const userId = res.locals.session.user_id,
      data = proof.parse(req.body);
    const user = await requireCurrentPassword(userId, data.password);
    await withMfaAttempt(store, userId, async (query) => {
      await lockWorkspaceSettings(query, store, userId);
      const [currentUser] = await query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id=$1",
        [userId],
      );
      if (!equal(currentUser.password_hash, user.password_hash)) {
        fail(409, "Password changed. Sign in again.");
      }
      await verifySecondFactor(query, vault, userId, data.token);
      await query("DELETE FROM user_security WHERE user_id=$1", [userId]);
      await query("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [
        userId,
        res.locals.session.token_hash,
      ]);
      await audit(
        query,
        "Authenticator MFA disabled; other app sessions revoked.",
        userId,
      );
    });
    await disconnectBroker(userId);
    res.json({ enabled: false });
  });
}
