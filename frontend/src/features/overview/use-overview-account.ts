"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import {
  applyPriceTicks,
  retainKnownExposure,
  type AccountSnapshot,
  type BrokerAccountAdapter,
} from "@/features/overview/account-model";

/** Own Overview's read-only account lifecycle; rendering components never call APIs.
 * Initial selection and explicit refresh load snapshots. Only the server's streamed-price
 * cache is polled, never broker positions, funds, order history or trade history.
 * Adapter/session changes invalidate pending responses. */
export function useOverviewAccount(
  broker: BrokerAccountAdapter | null,
  csrf: string,
  readMfa = true,
) {
  const [live, setLive] = useState<AccountSnapshot | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [mfaLoading, setMfaLoading] = useState(true);
  const [mfaRevision, setMfaRevision] = useState(0);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [feedMessage, setFeedMessage] = useState("Snapshot prices");
  const generation = useRef(0),
    inFlight = useRef(false);
  // Keep the fetched book separate from tick-derived state so price renders never resubscribe.
  const liveSnapshot = useRef<AccountSnapshot | null>(null);
  const liveSnapshotAt = live?.capturedAt;
  /** MFA belongs to the app session, not the selected broker. Cancel old reads on
   * logout/unmount; a failed or malformed response must never imply MFA is disabled. */
  useEffect(() => {
    if (!readMfa) {
      return;
    }
    const controller = new AbortController();
    setMfaEnabled(null);
    setMfaLoading(true);
    void requestApiJson(
      "/auth/mfa",
      "GET",
      undefined,
      undefined,
      15000,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setMfaEnabled(
            typeof result?.enabled === "boolean" ? result.enabled : null,
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMfaEnabled(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setMfaLoading(false);
        }
      });
    return () => controller.abort();
  }, [csrf, mfaRevision, readMfa]);

  /** Retry only the read-only security check; never refresh or authorize a broker. */
  function refreshMfaStatus() {
    setMfaRevision((revision) => revision + 1);
  }
  /** Serialize snapshot reads. Dependencies bind requests to the chosen adapter/session;
   * generation checks discard late results, and failures preserve the last known snapshot. */
  const loadAccountSnapshot = useCallback(
    /** Load only the configured account's connection status and funds/positions.
     * This callback handles its own rejection so event handlers can safely invoke it with void.
     * Returns `true` on success, the error message on failure, or `undefined` when this call
     * was skipped or superseded — callers use this only to surface refresh feedback (e.g. a
     * toast); it never changes what is requested or how failures are handled internally. */
    async (): Promise<true | string | undefined> => {
      if (!broker) {
        setConnected(false);
        setLive(null);
        liveSnapshot.current = null;
        setLoading(false);
        setError("");
        return true;
      }
      if (inFlight.current) {
        return undefined;
      }
      inFlight.current = true;
      // A new explicit read supersedes any slower account request from the last refresh.
      const version = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const result = await loadOverviewSnapshot(broker, csrf);
        if (version !== generation.current) {
          return undefined;
        }
        setConnected(result.connected);
        liveSnapshot.current = result.snapshot;
        setLive(
          /** Keep prior exposure until a successful broker snapshot proves it changed. */ (
            previous,
          ) => retainKnownExposure(previous, result.snapshot),
        );
        return true;
      } catch (failure) {
        if (version === generation.current) {
          setConnected(null);
          setLive(
            /** Failed transport is not evidence of an empty account. */ (
              previous,
            ) =>
              retainKnownExposure(
                previous,
                null,
                "Account refresh failed. Showing last known exposure and marks; reconciliation is required.",
              ),
          );
          const message =
            failure instanceof Error
              ? failure.message
              : "Account snapshot unavailable.";
          setError(message);
          return message;
        }
        return undefined;
      } finally {
        if (version === generation.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [broker, csrf],
  );
  /** Re-establish only the configured account when mode, adapter or session changes.
   * Cleanup invalidates pending reads, including React Strict Mode's development remount. */
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setLive(null);
    liveSnapshot.current = null;
    setConnected(null);
    void loadAccountSnapshot();
    // Capture the ref container, not its value: later manual refreshes must also be invalidated.
    const requestGeneration = generation;
    /** Invalidate outstanding account requests without changing shared broker connections. */
    return () => {
      requestGeneration.current++;
    };
  }, [loadAccountSnapshot]);
  /** Re-subscribe after adapter, session, mode, connection or snapshot identity changes.
   * Tick updates preserve capturedAt, so price renders do not recreate the timer.
   * Cleanup cancels this consumer, but leaves the shared feed available to other screens. */
  useEffect(() => {
    const subscribedSnapshot = liveSnapshot.current;
    if (!broker) {
      setFeedMessage("No connected broker selected");
      return;
    }
    if (!subscribedSnapshot?.positions?.length || connected !== true) {
      setFeedMessage("No active price subscription · last known values only");
      return;
    }
    if (!broker.supportsStreamingPrices) {
      setFeedMessage("Broker snapshot prices · refresh to update");
      return;
    }
    let cancelled = false,
      pending = false;
    setFeedMessage("Connecting price feed");
    // Adapter API: request the shared read-only price subscription, not trading authorization.
    void broker
      .startPositionFeed(csrf)
      .then(
        /** Ignore subscription acknowledgements after this effect was cleaned up. */ () => {
          if (!cancelled) {
            setFeedMessage("Waiting for fresh prices");
          }
        },
      )
      .catch(
        /** Keep the account snapshot visible when the subscription cannot start. */ (
          failure,
        ) => {
          if (!cancelled) {
            setFeedMessage(
              failure instanceof Error
                ? `Prices unavailable: ${failure.message}`
                : "Prices unavailable",
            );
          }
        },
      );
    /** Poll only the local server cache, skipping hidden tabs and overlapping reads.
     * One functional state update values both the table and headline from the same batch. */
    const timer = setInterval(async () => {
      if (cancelled || pending || document.hidden) {
        return;
      }
      pending = true;
      try {
        // Adapter API: cached streamed prices only, with no recurring account-report request.
        const ticks = await broker.readPriceTicks();
        if (cancelled) {
          return;
        }
        setLive(
          /** Value the newest state, not the snapshot captured when the timer started. */ (
            previous,
          ) => (previous ? applyPriceTicks(previous, ticks) : previous),
        );
        setFeedMessage(
          ticks.some(
            /** Only fresh ticks for this position book establish a meaningful feed status. */
            (tick) =>
              tick.fresh &&
              Number.isFinite(tick.price) &&
              tick.price >= 0 &&
              tick.receivedAt <= Date.now() &&
              Date.now() - tick.receivedAt <= 15000 &&
              subscribedSnapshot.positions!.some(
                /** Match exchange and token to avoid cross-segment collisions. */ (
                  position,
                ) =>
                  position.exchange === tick.exchange &&
                  position.instrument === tick.instrument,
              ),
          )
            ? "Contract quotes received · exchange trade freshness unverified"
            : "No fresh prices · showing last known marks",
        );
      } catch {
        if (!cancelled) {
          setFeedMessage("Feed unavailable · showing last known marks");
        }
      } finally {
        pending = false;
      }
    }, 1000);
    /** Cancel late responses and release the timer; never stop a feed owned by other consumers. */
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [broker, csrf, connected, liveSnapshotAt]);
  return {
    live,
    // Retained exposure may be visible during an outage, but cannot establish a current total.
    positionsCurrent:
      connected === true &&
      !loading &&
      !error &&
      Array.isArray(liveSnapshot.current?.positions),
    holdingsCurrent:
      connected === true &&
      !loading &&
      !error &&
      Array.isArray(liveSnapshot.current?.holdings),
    connected,
    mfaEnabled,
    mfaLoading,
    refreshMfaStatus,
    loading,
    error,
    feedMessage,
    loadAccountSnapshot,
  };
}

/** Read authentication first, then load one broker snapshot. */
export async function loadOverviewSnapshot(
  broker: BrokerAccountAdapter,
  csrf: string,
): Promise<{ connected: boolean; snapshot: AccountSnapshot | null }> {
  // Adapter APIs: authentication and one broker snapshot, with no automatic order submission.
  const connected = await broker.loadConnectionStatus();
  return {
    connected,
    snapshot: connected ? await broker.loadLiveAccount(csrf) : null,
  };
}
