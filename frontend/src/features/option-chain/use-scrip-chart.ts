"use client";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { requestApiJson } from "@/lib/api";

/** Pass the selected catalog ID, not the text currently being typed. */
export type ScripSelection = { id?: string; symbol?: string };
const datasetSchema = z.object({
  instrument: z.object({ id: z.string(), symbol: z.string() }).nullable(),
  candles: z.array(
    z
      .object({
        day: z.iso.date(),
        open: z.number().positive(),
        high: z.number().positive(),
        low: z.number().positive(),
        close: z.number().positive(),
        volume: z.number().nonnegative().nullable(),
      })
      .refine(
        (v) =>
          v.high >= Math.max(v.open, v.close, v.low) &&
          v.low <= Math.min(v.open, v.close),
      ),
  ),
  interval: z.literal("day"),
  adjustment: z.enum(["unadjusted", "unknown"]),
});
export type ScripChartDataset = z.infer<typeof datasetSchema>;

/** Public loader also supports non-hook consumers; requests use the authenticated app API. */
export async function loadScripChart(
  selection: ScripSelection,
  signal: AbortSignal,
  request: typeof requestApiJson = requestApiJson,
): Promise<ScripChartDataset> {
  let id = selection.id?.trim();
  const symbol = selection.symbol?.trim();
  if (!id && symbol) {
    const result = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            symbol: z.string(),
            series: z.string(),
            kind: z.string(),
          }),
        ),
      })
      .parse(
        await request(
          `/eod/instruments?q=${encodeURIComponent(symbol)}`,
          "GET",
          undefined,
          undefined,
          15000,
          signal,
        ),
      );
    const matches = result.items.filter(
      (item) =>
        item.symbol === symbol &&
        (item.kind === "index" || item.series === "EQ"),
    );
    if (matches.length === 1) {
      id = matches[0].id;
    }
  }
  if (!id) {
    throw new Error(
      "No unique imported history for this scrip. Select an instrument from the stored-data search.",
    );
  }
  signal.throwIfAborted();
  const data = datasetSchema.parse(
    await request(
      `/eod/candles?id=${encodeURIComponent(id)}`,
      "GET",
      undefined,
      undefined,
      15000,
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!data.instrument || !data.candles.length) {
    throw new Error(
      "No daily candles imported for this scrip. No sample prices are shown.",
    );
  }
  if (data.instrument.id !== id) {
    throw new Error("Chart response does not match the selected scrip.");
  }
  if (
    data.candles.some((bar, i) => i > 0 && bar.day <= data.candles[i - 1].day)
  ) {
    throw new Error("Invalid candle ordering.");
  }
  return data;
}

/** Idle until selected. Cancels obsolete requests and hides the previous scrip immediately. */
export function useScripChart(selection: ScripSelection | null) {
  const id = selection?.id?.trim() || "";
  const symbol = selection?.symbol?.trim() || "";
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([id, symbol, revision]);
  const [state, setState] = useState<{
    key: string;
    dataset: ScripChartDataset | null;
    error: string;
    loading: boolean;
  }>({ key: "", dataset: null, error: "", loading: false });
  useEffect(() => {
    if (!id && !symbol) {
      setState({ key, dataset: null, error: "", loading: false });
      return;
    }
    const controller = new AbortController();
    setState({ key, dataset: null, error: "", loading: true });
    void loadScripChart({ id, symbol }, controller.signal).then(
      (dataset) => {
        if (!controller.signal.aborted) {
          setState({ key, dataset, error: "", loading: false });
        }
      },
      (error) => {
        if (!controller.signal.aborted) {
          setState({
            key,
            dataset: null,
            error:
              error instanceof Error
                ? error.message
                : "Daily history unavailable.",
            loading: false,
          });
        }
      },
    );
    return () => controller.abort();
  }, [id, symbol, key]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const current = state.key === key && Boolean(id || symbol);
  return {
    dataset: current ? state.dataset : null,
    error: current ? state.error : "",
    loading: current ? state.loading : Boolean(id || symbol),
    reload,
  };
}
