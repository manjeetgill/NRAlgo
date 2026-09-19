/** Encrypted, login-bound broker capabilities. Passwords, MPIN and TOTP never enter this store. */
import type { Store } from "./database.js";
import type { credentialVault } from "./security.js";

export type BrokerOwner = {
  user_id: string;
  token_hash: string;
  expires: number;
};
export class BrokerSessionStore {
  private revisions = new Map<string, number>();
  public revision(userId: string) {
    return this.revisions.get(userId) || 0;
  }
  constructor(
    private db: Store,
    private vault: ReturnType<typeof credentialVault>,
  ) {}
  private context(owner: BrokerOwner, provider: string) {
    return `${owner.user_id}:broker-session:${provider}:${owner.token_hash}`;
  }
  public async save(
    owner: BrokerOwner,
    provider: string,
    expires: number,
    value: unknown,
  ) {
    const revision = this.revision(owner.user_id);
    const deadline = Math.min(expires, owner.expires * 1000);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      throw new Error("Broker session expired.");
    }
    const ciphertext = this.vault.seal(this.context(owner, provider), {
      expires: deadline,
      value,
    });
    await this.db.transaction(async (query) => {
      await query(
        "SELECT user_id FROM user_settings WHERE user_id=$1 FOR UPDATE",
        [owner.user_id],
      );
      if (revision !== this.revision(owner.user_id)) {
        throw new Error("Broker connection changed.");
      }
      // The FK and owner check prevent a late login response from reviving a logged-out session.
      const rows = await query(
        "INSERT INTO broker_sessions(user_id,session_hash,provider,expires,ciphertext) SELECT user_id,token_hash,$3,$4,$5 FROM sessions WHERE token_hash=$2 AND user_id=$1 AND expires*1000>$6 ON CONFLICT(session_hash,provider) DO UPDATE SET expires=EXCLUDED.expires,ciphertext=EXCLUDED.ciphertext RETURNING provider",
        [
          owner.user_id,
          owner.token_hash,
          provider,
          Math.min(expires, owner.expires * 1000),
          ciphertext,
          Date.now(),
        ],
      );
      if (!rows.length) {
        throw new Error("Application session expired.");
      }
    });
  }
  public async load(owner: BrokerOwner, provider: string) {
    const [row] = await this.db.transaction(async (query) => {
      await query("DELETE FROM broker_sessions WHERE expires<=$1", [
        Date.now(),
      ]);
      return query<{ ciphertext: string; expires: number }>(
        "SELECT b.ciphertext,b.expires FROM broker_sessions b JOIN sessions s ON s.token_hash=b.session_hash AND s.user_id=b.user_id WHERE b.user_id=$1 AND b.session_hash=$2 AND b.provider=$3 AND b.expires>$4 AND s.expires*1000>$4",
        [owner.user_id, owner.token_hash, provider, Date.now()],
      );
    });
    if (!row) {
      return null;
    }
    try {
      const decoded = this.vault.open(
        this.context(owner, provider),
        row.ciphertext,
      ) as { expires: number; value: unknown };
      if (
        !decoded ||
        typeof decoded.expires !== "number" ||
        !Number.isFinite(decoded.expires)
      ) {
        throw new Error("Invalid session envelope");
      }
      const expires = Math.min(
        row.expires,
        decoded.expires,
        owner.expires * 1000,
      );
      if (expires <= Date.now()) {
        return null;
      }
      return { expires, value: decoded.value };
    } catch {
      await this.remove(owner.user_id, provider);
      return null;
    }
  }
  public async remove(userId: string, provider?: string) {
    this.revisions.set(userId, this.revision(userId) + 1);
    await this.db.transaction(async (query) => {
      await query(
        "SELECT user_id FROM user_settings WHERE user_id=$1 FOR UPDATE",
        [userId],
      );
      await query(
        "DELETE FROM broker_sessions WHERE user_id=$1" +
          (provider ? " AND provider=$2" : ""),
        provider ? [userId, provider] : [userId],
      );
    });
  }
}
