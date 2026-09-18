"use client";
/** Owner-scoped, abortable research library read. No trading commands or wallet access. */
import { useCallback, useEffect, useState } from "react";
import { requestApiJson } from "@/lib/api";

export interface SavedResearchSummary {
  id: string;
  definition: {
    name: string;
    market: "cash" | "options";
    legs: { stockCode: string }[];
  };
}

/** Reject malformed responses instead of making an unavailable library look empty. */
export function parseStrategyLibrary(value: unknown): SavedResearchSummary[] {
  const rows = (value as { strategies?: unknown })?.strategies;
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        typeof row?.id === "string" &&
        typeof row?.definition?.name === "string" &&
        ["cash", "options"].includes(row?.definition?.market) &&
        Array.isArray(row?.definition?.legs) &&
        row.definition.legs.every(
          (leg: { stockCode?: unknown }) => typeof leg?.stockCode === "string",
        ),
    )
  ) {
    throw new Error("Saved strategy response is unavailable.");
  }
  return rows;
}

/** Read once per account; cleanup prevents a late response entering a different account/screen. */
export function useStrategyLibrary(csrf: string) {
  const [strategies, setStrategies] = useState<SavedResearchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  /** Explicit retry refetches this screen's library, not an unrelated workspace summary. */
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    /** Fetch the saved library, retaining errors instead of substituting records. */
    async function loadLibrary() {
      setLoading(true);
      setError("");
      setStrategies([]);
      try {
        const result = await requestApiJson(
          "/research",
          "GET",
          undefined,
          csrf,
          15000,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setStrategies(parseStrategyLibrary(result));
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Library unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }
    void loadLibrary();
    return () => controller.abort();
  }, [csrf, revision]);
  return { strategies, loading, error, refresh };
}
