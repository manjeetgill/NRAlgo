"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { applyPriceTicks } from "@/features/overview/overview-model";
import type {
  AccountMode,
  AccountSnapshot,
  BrokerAccountAdapter,
} from "@/features/overview/overview-types";

/** Own Overview's read-only account lifecycle; rendering components never call APIs.
 * Initial selection and explicit refresh load snapshots. Only the server's streamed-price
 * cache is polled, never broker positions, funds, order history or trade history.
 * Adapter/session changes invalidate pending responses; paper/live state stays separate. */
export function useOverviewAccount(
  broker: BrokerAccountAdapter,
  csrf: string,
  mode: AccountMode,
) {
  const [paper, setPaper] = useState<AccountSnapshot | null>(null);
  const [live, setLive] = useState<AccountSnapshot | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [feedMessage, setFeedMessage] = useState("Snapshot prices");
  const generation = useRef(0),
    inFlight = useRef(false);
  // Keep the fetched book separate from tick-derived state so price renders never resubscribe.
  const liveSnapshot = useRef<AccountSnapshot | null>(null);
  const liveSnapshotAt = live?.capturedAt;
  /** Serialize snapshot reads. Dependencies bind requests to the chosen adapter/session;
   * generation checks discard late results, and failures preserve the last known snapshot. */
  const loadAccountSnapshot = useCallback(
    /** Load readiness independently, then paper connection state and optionally live funds/positions.
     * This callback handles its own rejection so event handlers can safely invoke it with void. */
    async (requestedMode: AccountMode) => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      // A new explicit read also supersedes any slower readiness promise from the last refresh.
      const version = ++generation.current;
      setLoading(true);
      setError("");
      // GET /auth/mfa reads readiness only; no enrollment, authorization or broker mutation.
      void requestApiJson("/auth/mfa")
        .then(
          /** Publish readiness only for the session that initiated this request. */
          (result) => {
            if (version === generation.current) {
              setMfaEnabled(result.enabled === true);
            }
          },
        )
        .catch(
          /** A failed readiness read is unknown, not evidence that MFA is disabled. */
          () => {
            if (version === generation.current) {
              setMfaEnabled(null);
            }
          },
        );
      try {
        // Adapter API: read the virtual ledger and broker connection flag, never place orders.
        const result = await broker.loadPaperAccount();
        if (version !== generation.current) {
          return;
        }
        setPaper(result.snapshot);
        setConnected(result.connected);
        if (!result.connected) {
          liveSnapshot.current = null;
          setLive(null);
        }
        if (requestedMode === "live" && result.connected) {
          // Adapter API: one explicit report snapshot; do not retry automatically on failure.
          const snapshot = await broker.loadLiveAccount(csrf);
          if (version === generation.current) {
            liveSnapshot.current = snapshot;
            setLive(snapshot);
          }
        }
      } catch (failure) {
        if (version === generation.current) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Account snapshot unavailable.",
          );
        }
      } finally {
        if (version === generation.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    },
    [broker, csrf],
  );
  /** Re-establish the baseline when the memoized adapter/session loader changes.
   * Cleanup invalidates pending reads, including React Strict Mode's development remount. */
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setPaper(null);
    setLive(null);
    liveSnapshot.current = null;
    setConnected(null);
    setMfaEnabled(null);
    void loadAccountSnapshot("paper");
    /** Invalidate outstanding promises without changing shared broker connections. */
    return () => {
      generation.current++;
    };
  }, [loadAccountSnapshot]);
  /** Observe mode and load completion to fetch Live once after connection is established.
   * Cached snapshots are reused; errors stop automatic retries. No resource needs cleanup. */
  useEffect(() => {
    if (mode === "live" && !live && connected === true && !loading && !error) {
      void loadAccountSnapshot("live");
    }
  }, [mode, live, connected, loading, error, loadAccountSnapshot]);
  /** Re-subscribe after adapter, session, mode, connection or snapshot identity changes.
   * Tick updates preserve capturedAt, so price renders do not recreate the timer.
   * Cleanup cancels this consumer, but leaves the shared feed available to other screens. */
  useEffect(() => {
    const subscribedSnapshot = liveSnapshot.current;
    if (
      mode !== "live" ||
      !subscribedSnapshot?.positions?.length ||
      connected !== true
    ) {
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
            ? "Prices updating from shared feed"
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
  }, [broker, csrf, mode, connected, liveSnapshotAt]);
  return {
    paper,
    live,
    connected,
    mfaEnabled,
    loading,
    error,
    feedMessage,
    loadAccountSnapshot,
  };
}
