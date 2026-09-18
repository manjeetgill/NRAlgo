"use client";

/** Own the read-only order request lifecycle separately from order presentation and execution controls. */
import { useCallback, useEffect, useRef, useState } from "react";
import { loadLiveOrders, type LiveOrdersSnapshot } from "./live-orders-api";

/** Fetch on entry or explicit refresh, never on an automatic timer or from a simulated ledger. */
export function useLiveOrders() {
  const [snapshot, setSnapshot] = useState<LiveOrdersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);

  /** Fence stale responses after refresh/unmount and surface failed reads without reporting an empty book. */
  const onRefresh = useCallback(async () => {
    const requestId = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await loadLiveOrders();
      if (requestId === generation.current) {
        setSnapshot(next);
      }
    } catch (cause) {
      if (requestId === generation.current) {
        setError(
          cause instanceof Error ? cause.message : "Live orders unavailable.",
        );
      }
    } finally {
      if (requestId === generation.current) {
        setLoading(false);
      }
    }
  }, []);

  /** Start one read when the screen mounts; invalidate all pending reads when the account/screen changes. */
  useEffect(() => {
    void onRefresh(); // The callback handles all rejections and never retries mutations.
    const requestGeneration = generation;
    /** Prevent a late request from updating a departed account's view. */
    return () => {
      requestGeneration.current++;
    };
  }, [onRefresh]);

  return { snapshot, loading, error, onRefresh };
}
