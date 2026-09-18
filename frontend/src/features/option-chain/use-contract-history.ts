"use client";
/** Contract-scoped initial history only; live marks come from the existing shared option-chain feed. */
import { useEffect, useState } from "react";
import {
  fetchMarketHistory,
  type HistoryDataset,
  type HistoryRequest,
} from "@/lib/market-history";

/** Stable serialized identity avoids re-fetching history on each option-chain tick. */
export function useContractHistory(request: HistoryRequest, csrf: string) {
  const key = JSON.stringify(request);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    revision: number;
    dataset?: HistoryDataset;
    error?: string;
  } | null>(null);
  /** Abort stale selections and fence responses even if the underlying transport ignores cancellation. */
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const dataset = await fetchMarketHistory(
          JSON.parse(key) as HistoryRequest,
          csrf,
          controller.signal,
        );
        if (active) {
          setResult({ key, revision, dataset });
        }
      } catch (cause) {
        if (active) {
          setResult({
            key,
            revision,
            error:
              cause instanceof Error
                ? cause.message
                : "Broker history unavailable.",
          });
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, csrf, revision]);
  const current =
    result?.key === key && result.revision === revision ? result : null;
  return {
    dataset: current?.dataset,
    error: current?.error,
    loading: !current,
    /** Explicit user reload only; price ticks never trigger historical API calls. */
    reload: () => setRevision((value) => value + 1),
  };
}
