"use client";
/** Shared live/stored option-chain selection and the manual strategy payoff editor. */
import {
  createResearchDefinition,
  type ResearchDraft,
} from "@/features/research/research-draft";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
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
  initialSelection,
}: {
  csrf: string;
  draft?: ResearchDraft;
  initialSelection?: {
    underlying: string;
    expiry?: string;
    day?: string;
    spot?: number;
  };
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [underlying, setUnderlying] = useState(
    initialSelection?.underlying ?? draft?.definition.legs[0]?.stockCode ?? "",
  );
  const [dataMode, setDataMode] = useState<"live" | "historical">("historical");
  const [selectedLegs, setSelectedLegs] = useState<PayoffSelection[]>([]);
  // The shell supplies an initial handoff only. Subsequent additions are commands
  // to the mounted editor, not a second retained copy of its editable basket.
  const [addition, setAddition] = useState(draft);
  const [revision, setRevision] = useState(0);
  const [quoteRevision, setQuoteRevision] = useState(0);
  async function resetSpread() {
    const hadLegs = selectedLegs.length > 0;
    if (hadLegs) {
      const proceed = await confirm({
        title: "Discard this spread?",
        description:
          "This clears every leg in the current draft and starts a new one.",
        confirmLabel: "Discard",
        tone: "danger",
      });
      if (!proceed) {
        return false;
      }
    }
    setAddition(undefined);
    setSelectedLegs([]);
    setRevision((value) => value + 1);
    if (hadLegs) {
      toast({ tone: "info", title: "Spread cleared" });
    }
    return true;
  }
  function addLeg(contract: ChainContract, side: "buy" | "sell") {
    const option = contract.option;
    if (!option) {
      return "Select a listed option contract.";
    }
    if (!Number.isSafeInteger(contract.lotSize) || contract.lotSize < 1) {
      return "This contract has no verified lot size. Enter units manually in the builder.";
    }
    if (selectedLegs.length >= 12) {
      return "Remove a leg before adding another (maximum 12).";
    }
    if (
      selectedLegs.some(
        (leg) =>
          leg.stockCode !== contract.symbol ||
          leg.expiryDate !== option.expiryDate,
      )
    ) {
      return "Start a new spread before adding a different underlying or expiry.";
    }
    if (
      selectedLegs.some(
        (leg) =>
          leg.strikePrice === option.strikePrice && leg.right === option.right,
      )
    ) {
      return "This contract is already in your draft. Edit its side or lots in the builder.";
    }
    setAddition({
      savedId: "",
      definition: {
        ...createResearchDefinition("options"),
        legs: [
          {
            stockCode: contract.symbol,
            ...option,
            side,
            quantity: contract.lotSize,
          },
        ],
      },
      marketReferences:
        typeof contract.price === "number"
          ? [
              {
                stockCode: contract.symbol,
                ...option,
                price: contract.price,
                observedAt: contract.tickAt,
              },
            ]
          : [],
    });
    return "";
  }
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
                : "quote snapshot · not a live stream"}
            </p>
            <Button
              variant="secondary"
              onClick={async () => {
                if (!(await resetSpread())) {
                  return;
                }
                setUnderlying("");
                setReference(null);
              }}
            >
              Change scrip
            </Button>
            <Button variant="secondary" onClick={resetSpread}>
              New spread
            </Button>
            <Button
              variant="secondary"
              onClick={() => setQuoteRevision((value) => value + 1)}
            >
              Refresh quotes
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
              key={`${underlying}:${quoteRevision}`}
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
              onAddLeg={addLeg}
              activeLegs={selectedLegs.filter((leg) => leg.enabled)}
              onDataMode={setDataMode}
              onReferenceData={onReferenceData}
              experience="builder"
              compact
            />
          </div>
          <div className="strategy-market-payoff">
            <OptionsPayoffBuilder
              key={`${underlying}:${revision}`}
              csrf={csrf}
              draft={addition}
              initialUnderlying={underlying}
              onSelectionChange={setSelectedLegs}
              referenceSpot={reference?.spot}
              referenceDay={reference?.day}
              useStoredSpot={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}
