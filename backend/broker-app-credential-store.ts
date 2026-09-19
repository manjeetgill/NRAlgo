/**
 * Encrypted, workspace-scoped broker application credentials.
 *
 * Broker API keys are long-lived application secrets, unlike short-lived account
 * sessions. They are encrypted with the server vault, keyed by owner and provider,
 * and are never returned to the browser after being saved.
 */
import type { Store } from "./database.js";
import type { credentialVault } from "./security.js";

export class BrokerAppCredentialStore {
  constructor(
    private readonly db: Store,
    private readonly vault: ReturnType<typeof credentialVault>,
  ) {}

  /** Bind ciphertext to both the workspace owner and broker provider. */
  private context(userId: string, provider: string) {
    return `${userId}:broker-app:${provider}`;
  }

  /** Atomically replace one provider's encrypted application credentials. */
  public async save(userId: string, provider: string, value: unknown) {
    const ciphertext = this.vault.seal(this.context(userId, provider), value);
    await this.db.transaction(async (query) => {
      await query(
        "INSERT INTO broker_app_credentials(user_id,provider,ciphertext,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(user_id,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=EXCLUDED.updated_at",
        [userId, provider, ciphertext],
      );
    });
  }

  /** Decrypt one owner's credentials; corrupted ciphertext fails closed. */
  public async load(userId: string, provider: string) {
    const [row] = await this.db.transaction((query) =>
      query<{ ciphertext: string }>(
        "SELECT ciphertext FROM broker_app_credentials WHERE user_id=$1 AND provider=$2",
        [userId, provider],
      ),
    );
    if (!row) {
      return null;
    }
    return this.vault.open(this.context(userId, provider), row.ciphertext);
  }
}
