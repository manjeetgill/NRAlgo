"use client";
/** Shared live/stored option-chain selection and the manual strategy payoff editor. */
import type { ResearchDraft } from "@/features/research/research-draft";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  OptionsPayoffBuilder,
  type PayoffSelection,
} from "./options-payoff-builder";
import {
  LiveOptionChain,
  type ChainContract,
} from "@/components/live-option-chain";
import { UnderlyingSearch } from "@/components/underlying-search";
import { useMarketFeed } from "@/features/option-chain/use-market-feed";

/** Builder selections remain research inputs, never live-order authorization. */
export function SpreadBuilderScreen({
  csrf,
  draft,
  onAddLeg,
  initialSelection,
}: {
  csrf: string;
  draft?: ResearchDraft;
  onAddLeg: (contract: ChainContract, side: "buy" | "sell") => string;
  initialSelection?: {
    underlying: string;
    expiry?: string;
    day?: string;
    spot?: number;
  };
}) {
  const [underlying, setUnderlying] = useState(
    initialSelection?.underlying ?? draft?.definition.legs[0]?.stockCode ?? "",
  );
  const [dataMode, setDataMode] = useState<"live" | "historical">("historical");
  const [selectedLegs, setSelectedLegs] = useState<PayoffSelection[]>([]);
  const [reference, setReference] = useState<{
    spot: number;
    day?: string;
  } | null>(
    initialSelection?.spot
      ? { spot: initialSelection.spot, day: initialSelection.day }
      : null,
  );
  const onReferenceData = useCallback(
    (value: { spot: number; day?: string }) => setReference(value),
    [],
  );
  const feed = useMarketFeed(csrf, Boolean(underlying) && dataMode === "live");
  return (
    <div className="screen-stack">
      <section className="panel screen-card market-workspace-toolbar">
        {underlying ? (
          <div className="screen-toolbar">
            <p>
              <strong>{underlying}</strong> ·{" "}
              {dataMode === "live"
                ? "active broker live data"
                : "stored database snapshot"}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                if (
                  !window.dispatchEvent(
                    new Event("workspace-before-navigate", {
                      cancelable: true,
                    }),
                  )
                ) {
                  return;
                }
                setUnderlying("");
                setReference(null);
              }}
            >
              Change scrip
            </Button>
          </div>
        ) : (
          <div className="screen-stack">
            <div
              className="screen-toolbar"
              role="group"
              aria-label="Quick index selection"
            >
              {["NIFTY", "BANKNIFTY", "FINNIFTY"].map((symbol) => (
                <Button
                  key={symbol}
                  variant="secondary"
                  onClick={() => setUnderlying(symbol)}
                >
                  {symbol}
                </Button>
              ))}
            </div>
            <UnderlyingSearch
              csrf={csrf}
              selected={underlying}
              onSelect={(symbol) => {
                setReference(null);
                setUnderlying(symbol);
              }}
              experience="builder"
            />
          </div>
        )}
      </section>
      {underlying && (
        <div className="strategy-market-workspace">
          <div className="strategy-market-chain">
            {feed.error && dataMode === "live" && (
              <p role="alert" className="error">
                {feed.error}
              </p>
            )}
            <LiveOptionChain
              key={underlying}
              selectedUnderlying={underlying}
              initialExpiry={
                underlying === initialSelection?.underlying
                  ? initialSelection.expiry
                  : undefined
              }
              asOf={
                underlying === initialSelection?.underlying
                  ? initialSelection.day
                  : undefined
              }
              csrf={csrf}
              ticks={feed.ticks}
              onAddLeg={onAddLeg}
              activeLegs={selectedLegs}
              onDataMode={setDataMode}
              onReferenceData={onReferenceData}
              experience="builder"
              compact
            />
          </div>
          <div className="strategy-market-payoff">
            <OptionsPayoffBuilder
              csrf={csrf}
              draft={draft}
              initialUnderlying={underlying}
              onSelectionChange={setSelectedLegs}
              referenceSpot={reference?.spot}
              referenceDay={reference?.day}
            />
          </div>
        </div>
      )}
    </div>
  );
}
