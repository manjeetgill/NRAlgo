"use client";
/** Broker dataset loading and generation-fenced local calculations; no uploads or background history polling. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMarketHistory,
  type HistoryRequest,
  type HistoryDataset,
} from "@/lib/market-history";
import type { BacktestSettings, DailyBar } from "./daily-backtest";
import { createBacktestReport, dailyBarsFromHistory } from "./backtest-report";

/** Abort obsolete reads and invalidate reports whenever selected contract/range/settings change. */
export function useDailyBacktest(csrf: string) {
  const [dataset, setDataset] = useState<{
    history: HistoryDataset;
    bars: DailyBar[];
  } | null>(null);
  const [report, setReport] = useState<Awaited<
    ReturnType<typeof createBacktestReport>
  > | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const generation = useRef(0),
    runGeneration = useRef(0),
    pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  /** Dispose HTTP work and ignore late hashing results when the screen/session leaves. */
  useEffect(() => {
    mounted.current = true;
    const reads = generation,
      runs = runGeneration;
    return () => {
      mounted.current = false;
      reads.current++;
      runs.current++;
      request.current?.abort();
    };
  }, []);

  /** A rules edit cannot leave a result labelled with newer settings. */
  const invalidateReport = useCallback(() => {
    runGeneration.current++;
    setReport(null);
  }, []);

  /** Selection edits remove old data immediately, including a pending response for another contract. */
  const clearDataset = useCallback(() => {
    generation.current++;
    request.current?.abort();
    setDataset(null);
    setLoading(false);
    setError("");
    invalidateReport();
  }, [invalidateReport]);

  /** Fetch once from the configured provider; accept the complete response only after daily validation. */
  const loadHistory = useCallback(
    async (input: HistoryRequest) => {
      clearDataset();
      const current = ++generation.current;
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      try {
        const history = await fetchMarketHistory(
          input,
          csrf,
          controller.signal,
        );
        const bars = dailyBarsFromHistory(history);
        if (current === generation.current) {
          setDataset({ history, bars });
        }
      } catch (cause) {
        if (current === generation.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Broker history unavailable.",
          );
        }
      } finally {
        if (current === generation.current) {
          setLoading(false);
        }
      }
    },
    [csrf, clearDataset],
  );

  /** Bind each calculation/export to copied broker data and settings; no order API is reachable here. */
  const run = useCallback(
    async (settings: BacktestSettings) => {
      if (pending.current || loading || !dataset) {
        return;
      }
      pending.current = true;
      const current = ++runGeneration.current;
      setRunning(true);
      setError("");
      setReport(null);
      try {
        const next = await createBacktestReport(
          dataset.bars,
          settings,
          dataset.history,
        );
        if (current === runGeneration.current) {
          setReport(next);
        }
      } catch (cause) {
        if (current === runGeneration.current) {
          setError(cause instanceof Error ? cause.message : "Backtest failed.");
        }
      } finally {
        pending.current = false;
        if (mounted.current) {
          setRunning(false);
        }
      }
    },
    [dataset, loading],
  );
  return {
    bars: dataset?.bars ?? [],
    history: dataset?.history,
    report,
    error,
    loading,
    running,
    loadHistory,
    clearDataset,
    run,
    invalidateReport,
  };
}
