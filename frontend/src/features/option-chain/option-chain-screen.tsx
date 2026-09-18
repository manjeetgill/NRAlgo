"use client";
/** Dedicated live option-chain screen. Contract selection edits a research draft only. */
import {
  LiveOptionChain,
  type ChainContract,
} from "@/components/live-option-chain";
import { Button } from "@/components/ui/button";
import { useMarketFeed } from "./use-market-feed";
/** Initial selection loads metadata/quotes once; subsequent prices use the shared stream cache. */
export function OptionChainScreen({
  csrf,
  legCount,
  onAddLeg,
  onOpenBuilder,
}: {
  csrf: string;
  legCount: number;
  onAddLeg: (contract: ChainContract, side: "buy" | "sell") => string;
  onOpenBuilder: () => void;
}) {
  const feed = useMarketFeed(csrf);
  return (
    <section className="screen-stack" aria-label="Option chain workspace">
      <div className="screen-toolbar">
        <p>
          Select a call or put price to inspect its contract and add a draft
          leg.
        </p>
      </div>
      {feed.error && (
        <p role="alert" className="error">
          {feed.error}
        </p>
      )}
      <LiveOptionChain
        csrf={csrf}
        ticks={feed.ticks}
        onAddLeg={onAddLeg}
        compact
      />
      <div className="screen-toolbar">
        <p>Prices open contract details. The chain does not place orders.</p>
        <Button variant="secondary" onClick={onOpenBuilder}>
          Open builder ({legCount}) →
        </Button>
      </div>
    </section>
  );
}
