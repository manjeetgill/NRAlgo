"use client";
/** Read the server's shared stream cache; never fetch broker positions, reports or recurring REST quotes. */
import { useEffect, useState } from "react";
import { requestApiJson } from "@/lib/api";
import type { LiveTick } from "@/components/live-option-chain";
/** Sequential cache reads stop on navigation and pause when hidden; the shared socket remains server-owned. */
export function useMarketFeed(csrf: string) {
  const [ticks, setTicks] = useState<LiveTick[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    /** Consume only normalized records from the existing cached feed endpoint. */
    async function readFeed() {
      let retryDelay = 1000;
      let stopped = false;
      try {
        if (!document.hidden) {
          const result = await requestApiJson(
            "/market/feed",
            "GET",
            undefined,
            csrf,
            15000,
            controller.signal,
          );
          if (!controller.signal.aborted) {
            setTicks(Array.isArray(result.records) ? result.records : []);
            setError("");
          }
        }
      } catch (cause) {
        const status = (cause as { status?: number }).status;
        // A disconnected session needs user action, not a stream of rejected requests.
        stopped = status === 401 || status === 403 || status === 409;
        retryDelay = status === 429 ? 60000 : 5000;
        if (!controller.signal.aborted) {
          setTicks([]);
          setError(
            cause instanceof Error ? cause.message : "Price feed unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted && !stopped) {
          timer = setTimeout(readFeed, retryDelay);
        }
      }
    }
    void readFeed();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [csrf]);
  return { ticks, error };
}
