"use client";
/** Broker-sourced intraday ticks for one cash symbol, accumulated client-side into a
 * session tick history. Subscribes only while explicitly enabled (live tab selected,
 * regular market session open); never runs during off-market hours or unattended. */
import { useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { useMarketFeed } from "./use-market-feed";
import type { PriceTick } from "./intraday-candles";

/** Resolve the broker-tradable instrument token for an exact NSE cash symbol. */
async function resolveCashToken(
  symbol: string,
  csrf: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await requestApiJson(
    "/market/instruments",
    "POST",
    { market: "cash", query: symbol, offset: 0 },
    csrf,
    15000,
    signal,
  );
  const items = Array.isArray(result?.items) ? result.items : [];
  const match = items.find(
    (item: { symbol?: string; instrument?: string }) => item.symbol === symbol,
  );
  return typeof match?.instrument === "string" ? match.instrument : null;
}

export function useLiveIntraday(
  symbol: string,
  csrf: string,
  enabled: boolean,
) {
  const [token, setToken] = useState<string | null>(null);
  const [ticks, setTicks] = useState<PriceTick[]>([]);
  const [error, setError] = useState("");
  const lastSeenAt = useRef<number>(0);
  const feed = useMarketFeed(csrf, enabled && Boolean(token));

  // Reset accumulated history and resolve+subscribe whenever the symbol/enabled state changes.
  useEffect(() => {
    setTicks([]);
    lastSeenAt.current = 0;
    setToken(null);
    setError("");
    if (!enabled || !symbol) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const resolved = await resolveCashToken(
          symbol,
          csrf,
          controller.signal,
        );
        if (controller.signal.aborted) {
          return;
        }
        if (!resolved) {
          setError("No broker-tradable instrument found for this symbol.");
          return;
        }
        await requestApiJson(
          "/market/live-feed",
          "POST",
          { cashInstruments: [resolved] },
          csrf,
          15000,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setToken(resolved);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not start the live feed.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [symbol, csrf, enabled]);

  // Append only genuinely new ticks; the feed snapshot repeats the latest price each poll.
  useEffect(() => {
    if (!token) {
      return;
    }
    const match = feed.ticks.find((item) => item.instrument === token);
    if (
      !match ||
      typeof match.ltp !== "number" ||
      typeof match.receivedAt !== "number" ||
      match.receivedAt <= lastSeenAt.current
    ) {
      return;
    }
    lastSeenAt.current = match.receivedAt;
    setTicks((current) => [
      ...current,
      { price: match.ltp!, at: match.receivedAt! },
    ]);
  }, [feed.ticks, token]);

  return { ticks, error: error || feed.error, ready: Boolean(token) };
}
