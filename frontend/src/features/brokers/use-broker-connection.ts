"use client";
/** Broker authentication lifecycle, independent of account valuation and execution authorization. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrokerConnectionAdapter } from "@/features/brokers/broker-connection-adapter";

/** Serialize explicit connection actions and fence stale responses after session/provider changes. */
export function useBrokerConnection(
  adapter: BrokerConnectionAdapter,
  csrf: string,
) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
            setConnected(status);
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
          setConnected(status);
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
  return { connected, busy, error, changeConnection };
}
