"use client";
/** Own local dataset replacement and report invalidation; failed uploads retain the last valid dataset. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseDailyCsv,
  type BacktestSettings,
  type DailyBar,
} from "./daily-backtest";
import { createBacktestReport } from "./backtest-report";

/** Validate completely before replacing a dataset. An upload error never commits partial candles. */
export async function readDailyDataset(
  file: Pick<File, "name" | "size" | "text">,
) {
  if (file.size > 2000000) {
    throw new Error("CSV must be at most 2 MB.");
  }
  return { filename: file.name, bars: parseDailyCsv(await file.text()) };
}

/** Fence file reads and async report hashing against edits, later uploads and component unmount. */
export function useDailyBacktest() {
  const [dataset, setDataset] = useState<{
    filename: string;
    bars: DailyBar[];
  }>({ filename: "", bars: [] });
  const [report, setReport] = useState<Awaited<
    ReturnType<typeof createBacktestReport>
  > | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const fileGeneration = useRef(0),
    runGeneration = useRef(0),
    runPending = useRef(false),
    mounted = useRef(false);

  /** Invalidate late file/hash results without making any server request. */
  useEffect(() => {
    mounted.current = true;
    const uploads = fileGeneration,
      runs = runGeneration;
    return () => {
      mounted.current = false;
      uploads.current++;
      runs.current++;
    };
  }, []);

  /** Every executable input edit clears the old report; a late hash cannot restore it. */
  const invalidateReport = useCallback(() => {
    runGeneration.current++;
    setReport(null);
  }, []);

  /** Preserve the committed dataset on cancellation, malformed CSV and read failure. */
  const selectFile = useCallback(
    async (file: File | undefined) => {
      if (!file) {
        return;
      }
      const generation = ++fileGeneration.current;
      invalidateReport();
      setLoading(true);
      setError("");
      try {
        const next = await readDailyDataset(file);
        if (generation === fileGeneration.current) {
          setDataset(next);
        }
      } catch (cause) {
        if (generation === fileGeneration.current) {
          setError(
            `${cause instanceof Error ? cause.message : "CSV unavailable."} Previous valid data, if any, is unchanged.`,
          );
        }
      } finally {
        if (generation === fileGeneration.current) {
          setLoading(false);
        }
      }
    },
    [invalidateReport],
  );

  /** Calculate one bounded local run and bind its export to the exact accepted dataset and settings. */
  const run = useCallback(
    async (settings: BacktestSettings) => {
      if (runPending.current || loading) {
        return;
      }
      runPending.current = true;
      const generation = ++runGeneration.current;
      setRunning(true);
      setError("");
      setReport(null);
      try {
        const next = await createBacktestReport(
          dataset.bars,
          settings,
          dataset.filename,
        );
        if (generation === runGeneration.current) {
          setReport(next);
        }
      } catch (cause) {
        if (generation === runGeneration.current) {
          setError(cause instanceof Error ? cause.message : "Backtest failed.");
        }
      } finally {
        runPending.current = false;
        if (mounted.current) {
          setRunning(false);
        }
      }
    },
    [dataset, loading],
  );
  return {
    ...dataset,
    report,
    error,
    loading,
    running,
    selectFile,
    run,
    invalidateReport,
  };
}
