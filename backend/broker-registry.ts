/**
 * Durable, provider-neutral broker registry and active-broker selection.
 *
 * Authentication sessions remain inside provider clients. This module stores only a
 * one-way account binding, connection state and the user's routing preference; it
 * never stores or returns broker credentials. Live order routing must resolve and
 * reserve the active broker in the same transaction before using this preference.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { audit, type Store } from "./database.js";
import { credentialVault, fail, rateLimit } from "./security.js";
import { verifySecondFactor } from "./mfa.js";

export const brokerProviderSchema = z.enum(["kotak", "zerodha"]);
export type BrokerProvider = z.infer<typeof brokerProviderSchema>;

type BrokerRow = {
  id: string;
  provider: BrokerProvider;
  status: "connected" | "disconnected";
  connected_at: number;
  updated_at: number;
};
export type ActiveBrokerBinding = {
  id: string;
  provider: BrokerProvider;
  accountBinding: string;
};
export type BrokerConnectivityResolver = (
  provider: BrokerProvider,
  userId: string,
  sessionHash: string,
) => boolean;

/** Resolve the owner-selected connected broker. Reservation callers use FOR UPDATE so
 * changing the preference cannot race the durable order-to-broker binding.
 */
export async function resolveActiveBroker(
  query: import("./database.js").Query,
  userId: string,
  lock = false,
): Promise<ActiveBrokerBinding> {
  const [settings] = await query<{ active_broker_id: string | null }>(
    `SELECT active_broker_id FROM user_settings WHERE user_id=$1${lock ? " FOR UPDATE" : ""}`,
    [userId],
  );
  if (!settings?.active_broker_id) {
    fail(409, "Connect and select an active broker first.");
  }
  const [broker] = await query<{
    id: string;
    provider: BrokerProvider;
    account_binding: string;
    status: string;
  }>(
    `SELECT id,provider,account_binding,status FROM user_brokers WHERE id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`,
    [settings.active_broker_id, userId],
  );
  if (!broker || broker.status !== "connected") {
    fail(409, "Reconnect the active broker before using live trading.");
  }
  return {
    id: broker.id,
    provider: brokerProviderSchema.parse(broker.provider),
    accountBinding: broker.account_binding,
  };
}

/** Register a verified provider account and select it only when no preference exists. */
export async function recordBrokerConnected(
  store: Store,
  userId: string,
  provider: BrokerProvider,
  accountBinding: string,
) {
  if (!new RegExp(`^${provider}:[a-f0-9]{64}$`).test(accountBinding)) {
    throw new Error("Broker account binding does not match its provider.");
  }
  const timestamp = Date.now() / 1000;
  return store.transaction(async (query) => {
    const [settings] = await query<{ active_broker_id: string | null }>(
      "SELECT active_broker_id FROM user_settings WHERE user_id=$1 FOR UPDATE",
      [userId],
    );
    if (!settings) {
      throw new Error("Broker owner settings are missing.");
    }
    const [broker] = await query<{ id: string }>(
      "INSERT INTO user_brokers(id,user_id,provider,account_binding,status,connected_at,updated_at) VALUES($1,$2,$3,$4,'connected',$5,$5) ON CONFLICT(user_id,provider) DO UPDATE SET account_binding=EXCLUDED.account_binding,status='connected',connected_at=EXCLUDED.connected_at,updated_at=EXCLUDED.updated_at RETURNING id",
      [randomUUID(), userId, provider, accountBinding, timestamp],
    );
    if (!settings.active_broker_id) {
      await query(
        "UPDATE user_settings SET active_broker_id=$2 WHERE user_id=$1",
        [userId, broker.id],
      );
      await audit(query, `Active broker selected: ${provider}.`, userId);
    }
    await audit(query, `Broker connected: ${provider}.`, userId);
    return broker.id;
  });
}

/** Mark provider connectivity unavailable without rewriting the user's preference. */
export async function recordBrokerDisconnected(
  store: Store,
  userId: string,
  provider: BrokerProvider,
) {
  return store.transaction(async (query) => {
    const rows = await query<{ id: string }>(
      "UPDATE user_brokers SET status='disconnected',updated_at=$3 WHERE user_id=$1 AND provider=$2 RETURNING id",
      [userId, provider, Date.now() / 1000],
    );
    if (rows.length) {
      await audit(query, `Broker disconnected: ${provider}.`, userId);
    }
    return rows.length > 0;
  });
}

/** Return safe broker metadata for one owner; account bindings never cross this boundary. */
async function listBrokers(
  store: Store,
  userId: string,
  sessionHash: string,
  isConnected?: BrokerConnectivityResolver,
) {
  return store.transaction(async (query) => {
    const [settings] = await query<{ active_broker_id: string | null }>(
      "SELECT active_broker_id FROM user_settings WHERE user_id=$1",
      [userId],
    );
    const brokers = await query<BrokerRow>(
      "SELECT id,provider,status,connected_at,updated_at FROM user_brokers WHERE user_id=$1 ORDER BY provider,id",
      [userId],
    );
    return {
      activeBrokerId: settings?.active_broker_id ?? null,
      brokers: brokers.map((broker) => {
        const connected = isConnected
          ? isConnected(broker.provider, userId, sessionHash)
          : broker.status === "connected";
        return {
          id: broker.id,
          provider: broker.provider,
          status: connected
            ? ("connected" as const)
            : ("disconnected" as const),
          connectedAt: broker.connected_at * 1000,
          updatedAt: broker.updated_at * 1000,
        };
      }),
    };
  });
}

/** Change the future routing preference transactionally; disconnected brokers cannot be selected. */
async function selectActiveBroker(
  store: Store,
  vault: ReturnType<typeof credentialVault>,
  token: string,
  userId: string,
  brokerId: string,
  sessionHash: string,
  isConnected?: BrokerConnectivityResolver,
) {
  return store.transaction(async (query) => {
    const [settings] = await query<{ active_broker_id: string | null }>(
      "SELECT active_broker_id FROM user_settings WHERE user_id=$1 FOR UPDATE",
      [userId],
    );
    if (!settings) {
      fail(409, "Account settings are unavailable.");
    }
    const [target] = await query<BrokerRow>(
      "SELECT id,provider,status,connected_at,updated_at FROM user_brokers WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [brokerId, userId],
    );
    if (!target) {
      fail(404, "Broker connection not found.");
    }
    if (target.status !== "connected") {
      fail(409, "Reconnect this broker before making it active.");
    }
    if (isConnected && !isConnected(target.provider, userId, sessionHash)) {
      fail(
        409,
        "This broker session is no longer connected. Reconnect it first.",
      );
    }
    const changed = settings.active_broker_id !== target.id;
    if (changed) {
      // Consume proof under the settings lock, before changing any routing state.
      const [security] = await query<{ enabled: boolean }>(
        "SELECT enabled FROM user_security WHERE user_id=$1",
        [userId],
      );
      if (!security?.enabled) {
        fail(
          409,
          "Enable authenticator MFA in Account & security before changing your live broker.",
        );
      }
      await verifySecondFactor(query, vault, userId, token);
      // Switching away and back must not resurrect a previous live authorization.
      await query(
        "DELETE FROM live_permissions WHERE account_id IN (SELECT id FROM live_accounts WHERE user_id=$1)",
        [userId],
      );
      await query(
        "UPDATE user_settings SET active_broker_id=$2 WHERE user_id=$1",
        [userId, target.id],
      );
      await audit(
        query,
        `Active broker changed to ${target.provider}.`,
        userId,
      );
    }
    return {
      activeBrokerId: target.id,
      changed,
      warning: changed
        ? "Existing orders and positions remain assigned to the broker where they were created."
        : null,
    };
  });
}

/** Mount owner-scoped registry reads and active selection after app authentication and CSRF. */
export function registerBrokerRegistryRoutes(
  app: Express,
  store: Store,
  vault: ReturnType<typeof credentialVault>,
  isConnected?: BrokerConnectivityResolver,
) {
  const limit = rateLimit(30, 60000, (req) => req.res!.locals.session.user_id);
  app.get("/api/brokers", limit, async (_req, res) => {
    const session = res.locals.session;
    res.json(
      await listBrokers(
        store,
        session.user_id,
        session.token_hash,
        isConnected,
      ),
    );
  });
  const proofLimit = rateLimit(
    10,
    60000,
    (req) => req.res!.locals.session.user_id,
  );
  app.post("/api/brokers/active", proofLimit, async (req, res) => {
    const { brokerId, token } = z
      .object({ brokerId: z.string().uuid(), token: z.string().min(6).max(32) })
      .strict()
      .parse(req.body);
    const session = res.locals.session;
    res.json(
      await selectActiveBroker(
        store,
        vault,
        token,
        session.user_id,
        brokerId,
        session.token_hash,
        isConnected,
      ),
    );
  });
}
