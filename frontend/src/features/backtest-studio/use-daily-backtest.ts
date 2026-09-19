"use client";
/** Stored-history loading plus owner-scoped Python job lifecycle; no calculation runs in React. */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import type { HistoryDataset } from "@/lib/market-history";
import { fetchStoredDailyHistory } from "@/lib/stored-market-history";
import type { StoredInstrument } from "@/lib/stored-instruments";
import type { BacktestSettings, DailyBar } from "./backtest-report";
import {
  backtestReportSchema,
  backtestSettingsPayload,
  dailyBarsFromHistory,
  type BacktestReport,
} from "./backtest-report";

/** Resolve after a cancellable browser delay between bounded status reads. */
function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Abort obsolete reads/jobs and bind every result to one selected stored dataset. */
export function useDailyBacktest(csrf: string) {
  const [dataset, setDataset] = useState<{
    history: HistoryDataset;
    bars: DailyBar[];
  } | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const historyRequest = useRef<AbortController | null>(null);
  const jobRequest = useRef<AbortController | null>(null);
  const jobId = useRef("");

  /** Request durable cancellation best effort; generation fencing still rejects late results. */
  const cancelJob = useCallback(() => {
    const id = jobId.current;
    jobId.current = "";
    jobRequest.current?.abort();
    jobRequest.current = null;
    if (id) {
      void requestApiJson(
        `/calculations/jobs/${encodeURIComponent(id)}`,
        "DELETE",
        undefined,
        csrf,
        15000,
      ).catch(() => {});
    }
    pending.current = false;
    setRunning(false);
    setProgress(0);
  }, [csrf]);

  /** Dispose all in-flight HTTP work when the screen or authenticated workspace changes. */
  useEffect(
    () => () => {
      generation.current++;
      historyRequest.current?.abort();
      cancelJob();
    },
    [cancelJob],
  );

  /** A rules edit cannot leave a result labelled with newer settings. */
  const invalidateReport = useCallback(() => {
    generation.current++;
    cancelJob();
    setReport(null);
  }, [cancelJob]);

  /** Selection edits remove old data immediately, including a pending response for another contract. */
  const clearDataset = useCallback(() => {
    generation.current++;
    historyRequest.current?.abort();
    setDataset(null);
    setLoading(false);
    setError("");
    cancelJob();
    setReport(null);
  }, [cancelJob]);

  /** Fetch stored history for visual confirmation; the job later re-reads it on Node. */
  const loadHistory = useCallback(
    async (instrument: StoredInstrument, from: string, to: string) => {
      clearDataset();
      const current = ++generation.current;
      const controller = new AbortController();
      historyRequest.current = controller;
      setLoading(true);
      try {
        const history = await fetchStoredDailyHistory(
          instrument,
          from,
          to,
          controller.signal,
        );
        const bars = dailyBarsFromHistory(history);
        if (current === generation.current) {
          setDataset({ history, bars });
        }
      } catch (cause) {
        if (current === generation.current && !controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Stored history unavailable.",
          );
        }
      } finally {
        if (current === generation.current) {
          setLoading(false);
        }
      }
    },
    [clearDataset],
  );

  /** Create a durable job, poll owned state, and accept only a schema-valid terminal result. */
  const run = useCallback(
    async (settings: BacktestSettings) => {
      if (pending.current || loading || !dataset) {
        return;
      }
      pending.current = true;
      const current = ++generation.current;
      const controller = new AbortController();
      jobRequest.current = controller;
      setRunning(true);
      setProgress(0);
      setError("");
      setReport(null);
      try {
        const request = dataset.history.request;
        const created = await requestApiJson(
          "/calculations/backtests",
          "POST",
          {
            instrumentId: request.instrument,
            symbol: request.stockCode,
            from: request.from,
            to: request.to,
            settings: backtestSettingsPayload(settings),
          },
          csrf,
          30000,
          controller.signal,
        );
        jobId.current = String(created.id);
        for (;;) {
          await wait(500, controller.signal);
          const state = await requestApiJson(
            `/calculations/jobs/${encodeURIComponent(jobId.current)}`,
            "GET",
            undefined,
            undefined,
            30000,
            controller.signal,
          );
          if (current !== generation.current) {
            return;
          }
          setProgress(Number(state.progress) || 0);
          if (state.status === "completed") {
            setReport(backtestReportSchema.parse(state.result));
            jobId.current = "";
            return;
          }
          if (state.status === "failed" || state.status === "cancelled") {
            throw new Error(
              state.error ||
                (state.status === "cancelled"
                  ? "Backtest cancelled."
                  : "Backtest failed."),
            );
          }
        }
      } catch (cause) {
        if (current === generation.current && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Backtest failed.");
        }
      } finally {
        if (current === generation.current) {
          pending.current = false;
          jobRequest.current = null;
          setRunning(false);
        }
      }
    },
    [csrf, dataset, loading],
  );
  return {
    bars: dataset?.bars ?? [],
    history: dataset?.history,
    report,
    error,
    loading,
    running,
    progress,
    loadHistory,
    clearDataset,
    run,
    cancelJob,
    invalidateReport,
  };
}
