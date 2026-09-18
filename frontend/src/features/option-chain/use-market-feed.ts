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
      try {
        if (!document.hidden) {
          const result = await requestApiJson(
            "/market/kotak/feed",
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
        if (!controller.signal.aborted) {
          setTicks([]);
          setError(
            cause instanceof Error ? cause.message : "Price feed unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(readFeed, 1000);
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
