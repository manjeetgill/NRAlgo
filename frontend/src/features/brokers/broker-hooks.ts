"use client";
/**
 * Broker authentication and active-selection hooks shared by connection and order-entry screens.
 * Credentials remain transient; reads are fenced and mutations are never retried automatically.
 * Authentication and broker selection do not grant live execution authorization.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { requestApiJson } from "@/lib/api";

/** Extensible connection contract; credentials stay in memory and are never persisted by the browser. */
export interface BrokerConnectionAdapter {
  id: string;
  name: string;
  fields: readonly { name: string; label: string; type: "text" | "password" }[];
  loadStatus(): Promise<{ connected: boolean; expiresAt: number | null }>;
  connect(credentials: Record<string, string>, csrf: string): Promise<unknown>;
  disconnect(csrf: string): Promise<unknown>;
}

/** Kotak uses an in-app credential form; Zerodha uses the separate redirect hook below. */
export const brokerConnectionAdapters: readonly BrokerConnectionAdapter[] = [
  {
    id: "kotak",
    name: "Kotak Neo",
    fields: [
      { name: "accessToken", label: "API access token", type: "password" },
      { name: "mobileNumber", label: "Mobile (+91…)", type: "text" },
      { name: "ucc", label: "Client code (UCC)", type: "text" },
      { name: "totp", label: "Authenticator TOTP", type: "password" },
      { name: "mpin", label: "MPIN", type: "password" },
    ],
    /** GET reads the owner/session-scoped connection flag without creating a virtual ledger. */
    async loadStatus() {
      const response = await requestApiJson("/brokers/kotak/status");
      if (typeof response.connected !== "boolean") {
        throw new Error("Broker connection status is unavailable.");
      }
      return {
        connected: response.connected,
        expiresAt:
          typeof response.expiresAt === "number" ? response.expiresAt : null,
      };
    },
    /** POST authenticates with the broker; CSRF is required and no orders are submitted or armed. */
    connect(credentials, csrf) {
      return requestApiJson(
        "/brokers/kotak/connect",
        "POST",
        credentials,
        csrf,
        95000,
      );
    },
    /** DELETE drops this user's in-memory broker session; the caller must explicitly request it. */
    disconnect(csrf) {
      return requestApiJson(
        "/brokers/kotak/connect",
        "DELETE",
        undefined,
        csrf,
      );
    },
  },
];

/** Serialize explicit connection actions and fence stale responses after session/provider changes. */
export function useBrokerConnection(
  adapter: BrokerConnectionAdapter,
  csrf: string,
) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  /** Read status on adapter/session change; cleanup only invalidates reads, never disconnects the broker. */
  useEffect(() => {
    const version = ++generation.current;
    pending.current = false;
    setBusy(false);
    setConnected(null);
    setError("");
    // Read-only API promise. Missing status is unknown, never an assumed successful connection.
    void adapter
      .loadStatus()
      .then(
        /** Ignore acknowledgements for a previous account/session. */ (
          status,
        ) => {
          if (version === generation.current) {
            setConnected(status.connected);
            setExpiresAt(status.expiresAt);
            setCheckedAt(Date.now());
          }
        },
      )
      .catch(
        /** Retain unknown status and expose a safe server error. */ (
          failure,
        ) => {
          if (version === generation.current) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Connection status unavailable.",
            );
          }
        },
      );
    // Later explicit actions also advance the counter; cleanup must invalidate their latest value.
    const requestGeneration = generation;
    /** Invalidate pending requests without modifying the shared broker session. */
    return () => {
      requestGeneration.current++;
    };
  }, [adapter, csrf]);
  /** Inspect server-side session health on user intent; this never authenticates or arms trading. */
  const refreshStatus = useCallback(async () => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const status = await adapter.loadStatus();
      if (version === generation.current) {
        setConnected(status.connected);
        setExpiresAt(status.expiresAt);
        setCheckedAt(Date.now());
      }
    } catch (failure) {
      if (version === generation.current) {
        setConnected(null);
        setError(
          failure instanceof Error
            ? failure.message
            : "Session status unavailable.",
        );
      }
    } finally {
      if (version === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [adapter]);

  /** Explicit user action only: credentials mean connect, otherwise disconnect. Never retry automatically. */
  const changeConnection = useCallback(
    async (credentials?: Record<string, string>) => {
      if (pending.current) {
        return;
      }
      pending.current = true;
      const version = ++generation.current;
      setBusy(true);
      setError("");
      try {
        // Provider API mutation changes authentication only; execution controls remain independent.
        if (credentials) {
          await adapter.connect(credentials, csrf);
        } else {
          await adapter.disconnect(csrf);
        }
        const status = await adapter.loadStatus();
        if (version === generation.current) {
          setConnected(status.connected);
          setExpiresAt(status.expiresAt);
          setCheckedAt(Date.now());
          return status.connected === Boolean(credentials);
        }
      } catch (failure) {
        if (version === generation.current) {
          setConnected(null);
          setError(
            failure instanceof Error
              ? failure.message
              : "Broker connection unavailable.",
          );
        }
      } finally {
        if (version === generation.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [adapter, csrf],
  );
  return {
    connected,
    busy,
    error,
    checkedAt,
    expiresAt,
    refreshStatus,
    changeConnection,
  };
}

/** Provider-neutral registry metadata contains no broker credentials. */
const registeredBrokerSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(["kotak", "zerodha"]),
  status: z.enum(["connected", "disconnected"]),
  connectedAt: z.number().finite(),
  updatedAt: z.number().finite(),
});
const registrySchema = z.object({
  activeBrokerId: z.string().uuid().nullable(),
  brokers: z.array(registeredBrokerSchema),
});
const selectionSchema = z.object({
  activeBrokerId: z.string().uuid(),
  changed: z.boolean(),
  warning: z.string().nullable(),
});

export type RegisteredBroker = z.infer<typeof registeredBrokerSchema>;

/** Fence stale reads and serialize active-broker changes without retrying mutations. */
export function useBrokerRegistry(csrf: string, refreshKey: number | null) {
  const [registry, setRegistry] = useState<z.infer<typeof registrySchema>>({
    activeBrokerId: null,
    brokers: [],
  });
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  const pendingSelection = useRef(false);

  /** Fence promise completions after this broker screen has unmounted. */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Load owner-scoped broker metadata; cancellation prevents an old screen from updating state. */
  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const value = registrySchema.parse(
        await requestApiJson(
          "/brokers",
          "GET",
          undefined,
          undefined,
          15000,
          signal,
        ),
      );
      if (
        mounted.current &&
        version === generation.current &&
        !signal?.aborted
      ) {
        setRegistry(value);
      }
    } catch (failure) {
      if (
        mounted.current &&
        version === generation.current &&
        !signal?.aborted
      ) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Broker registry is unavailable.",
        );
      }
    } finally {
      if (
        mounted.current &&
        version === generation.current &&
        !signal?.aborted
      ) {
        setLoading(false);
      }
    }
  }, []);

  /** Refresh after initial mount and after a provider connection check completes. */
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load, refreshKey]);

  /** Select the broker for future intents; one explicit mutation is followed by one authoritative read. */
  const select = useCallback(
    async (brokerId: string) => {
      if (pendingSelection.current || brokerId === registry.activeBrokerId) {
        return;
      }
      pendingSelection.current = true;
      setSelecting(true);
      setError("");
      setWarning("");
      try {
        const result = selectionSchema.parse(
          await requestApiJson("/brokers/active", "POST", { brokerId }, csrf),
        );
        if (mounted.current) {
          setWarning(result.warning ?? "");
        }
        await load();
      } catch (failure) {
        if (mounted.current) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Active broker could not be changed.",
          );
        }
      } finally {
        pendingSelection.current = false;
        if (mounted.current) {
          setSelecting(false);
        }
      }
    },
    [csrf, load, registry.activeBrokerId],
  );

  return { ...registry, loading, selecting, error, warning, select, load };
}

const connectionSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  expiresAt: z.number().nullable().optional(),
  callbackUrl: z.string().url(),
  account: z.object({ user_id: z.string(), user_name: z.string() }).nullable(),
});

/** Manage Zerodha redirect login and read-only session verification; SDK secrets stay on Express. */
export function useZerodhaConnection(csrf: string) {
  const [connection, setConnection] = useState<z.infer<
    typeof connectionSchema
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    requestApiJson(
      "/brokers/zerodha",
      "GET",
      undefined,
      undefined,
      15000,
      abort.signal,
    )
      .then((data) => {
        if (!abort.signal.aborted) {
          setConnection(connectionSchema.parse(data));
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError(
            "Unable to load Zerodha status. Check that the updated API is running.",
          );
        }
      });
    return () => abort.abort();
  }, []);
  async function action(kind: "login" | "verify" | "disconnect") {
    if (busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await requestApiJson(
        `/brokers/zerodha/${kind}`,
        "POST",
        {},
        csrf,
      );
      if (kind === "login") {
        const url = new URL(
          z.object({ url: z.string().url() }).parse(result).url,
        );
        if (
          url.protocol !== "https:" ||
          !["kite.zerodha.com", "kite.trade"].includes(url.hostname)
        ) {
          throw new Error("Unexpected login destination.");
        }
        window.location.assign(url.href);
      } else {
        setConnection(connectionSchema.parse(result));
        if (typeof result.warning === "string") {
          setError(result.warning);
        }
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to update Zerodha connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  return { connection, busy, error, action };
}
