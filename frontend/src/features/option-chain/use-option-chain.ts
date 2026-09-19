"use client";

import { useMemo } from "react";
import type { BrokerInstrument } from "@/components/instrument-picker";

export type OptionChainMode = "live" | "historical";

export type LiveTick = {
  exchange: string;
  instrument: string;
  ltp?: number;
  receivedRecently?: boolean;
  receivedAt?: number;
  openInterest?: number;
  volume?: string;
  change?: number;
  depth?: {
    buy: { price: number; quantity?: number }[];
    sell: { price: number; quantity?: number }[];
  };
};

export type ChainContract = BrokerInstrument & {
  price: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  stale: boolean;
  tickAt?: number;
  volume?: number | null;
  change?: number | null;
};

export type OptionChainSnapshot = {
  source?: string;
  warning?: string;
  items: ChainContract[];
  expiries: string[];
  total: number;
  nextOffset: number | null;
  dataMode?: OptionChainMode;
  observedAt?: number;
  pageOffset?: number;
  sessionDay?: string;
  underlyingPrice?: number | null;
};

export type OptionPair = {
  call?: ChainContract;
  put?: ChainContract;
};

export type OptionChainData = {
  items: ChainContract[];
  pairs: ReadonlyMap<number, OptionPair>;
  maxOpenInterest: number;
  tickByInstrument: ReadonlyMap<string, LiveTick>;
  liveInstruments: ReadonlySet<string>;
};

function isUsableTick(tick: LiveTick) {
  return (
    tick.receivedRecently === true &&
    typeof tick.ltp === "number" &&
    Number.isFinite(tick.ltp) &&
    tick.ltp > 0
  );
}

/**
 * Normalize one stored/live snapshot for display. Historical observations are
 * immutable replay evidence; only a live snapshot may be overlaid with recent
 * records from the shared market feed.
 */
export function buildOptionChainData(
  snapshot: OptionChainSnapshot | null,
  ticks: LiveTick[],
): OptionChainData {
  const acceptsLiveTicks = snapshot?.dataMode !== "historical";
  const tickByInstrument = new Map<string, LiveTick>();
  if (acceptsLiveTicks) {
    for (const tick of ticks) {
      if (tick.exchange === "nse_fo") {
        tickByInstrument.set(String(tick.instrument), tick);
      }
    }
  }

  const liveInstruments = new Set<string>();
  const items = (snapshot?.items ?? []).map((item) => {
    const tick = tickByInstrument.get(item.instrument);
    if (!tick || !isUsableTick(tick)) {
      return item;
    }
    liveInstruments.add(item.instrument);
    return {
      ...item,
      price: tick.ltp!,
      volume:
        tick.volume !== null &&
        tick.volume !== undefined &&
        Number.isSafeInteger(Number(tick.volume))
          ? Number(tick.volume)
          : item.volume,
      change: typeof tick.change === "number" ? tick.change : item.change,
      bid:
        typeof tick.depth?.buy?.[0]?.price === "number"
          ? tick.depth.buy[0].price
          : item.bid,
      ask:
        typeof tick.depth?.sell?.[0]?.price === "number"
          ? tick.depth.sell[0].price
          : item.ask,
      openInterest:
        typeof tick.openInterest === "number"
          ? tick.openInterest
          : item.openInterest,
      tickAt: tick.receivedAt,
      stale: false,
    };
  });

  const pairs = new Map<number, OptionPair>();
  for (const item of items) {
    if (!item.option) {
      continue;
    }
    const pair = pairs.get(item.option.strikePrice) ?? {};
    pair[item.option.right] = item;
    pairs.set(item.option.strikePrice, pair);
  }

  return {
    items,
    pairs,
    maxOpenInterest: Math.max(
      1,
      ...items.map((item) => item.openInterest ?? 0),
    ),
    tickByInstrument,
    liveInstruments,
  };
}

/** Present historical snapshots and live chains through one stable display model. */
export function useOptionChain(
  snapshot: OptionChainSnapshot | null,
  ticks: LiveTick[],
) {
  return useMemo(
    () => buildOptionChainData(snapshot, ticks),
    [snapshot, ticks],
  );
}
