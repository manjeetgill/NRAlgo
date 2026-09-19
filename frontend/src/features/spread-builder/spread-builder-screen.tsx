"use client";
/** Spread authorship reuses broker-neutral research, not the real-money order ticket. */
import type { ResearchDraft } from "@/features/research/research-draft";
import { createResearchDefinition } from "@/features/research/research-draft";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { OptionsPayoffBuilder } from "./options-payoff-builder";
import {
  LiveOptionChain,
  type ChainContract,
} from "@/components/live-option-chain";
import { UnderlyingSearch } from "@/components/underlying-search";
import { useMarketFeed } from "@/features/option-chain/use-market-feed";
import styles from "./simulator.module.css";
/** Return the exchange calendar day independently of the browser's timezone. */
const exchangeDay = () =>
  new Date(Date.now() + 19800000).toISOString().slice(0, 10);
/** Live/current builder entry point; historical replay is exposed as a separate screen. */
export function SpreadBuilderScreen({
  csrf,
  draft,
  onAddLeg,
}: {
  csrf: string;
  draft?: ResearchDraft;
  onAddLeg: (contract: ChainContract, side: "buy" | "sell") => string;
}) {
  return (
    <OptionsWorkspace
      csrf={csrf}
      draft={draft}
      onAddLeg={onAddLeg}
      experience="builder"
    />
  );
}

/** Shared option-chain/payoff surface; its caller permanently selects live or replay semantics. */
export function OptionsWorkspace({
  csrf,
  draft,
  onAddLeg,
  experience,
}: {
  csrf: string;
  draft?: ResearchDraft;
  onAddLeg: (contract: ChainContract, side: "buy" | "sell") => string;
  experience: "builder" | "simulator";
}) {
  const [asOf, setAsOf] = useState(exchangeDay);
  const [underlying, setUnderlying] = useState(
    experience === "simulator" ? "NIFTY" : "",
  );
  const [dataMode, setDataMode] = useState<"live" | "historical">("historical");
  const [simulationDraft, setSimulationDraft] = useState<ResearchDraft>({
    savedId: "",
    definition: createResearchDefinition("options"),
  });
  /** Saved observations enter a separate basket; never mix live-builder marks into replay. */
  const addSimulationLeg = (contract: ChainContract, side: "buy" | "sell") => {
    const option = contract.option;
    if (
      !option ||
      contract.symbol !== underlying ||
      typeof contract.price !== "number" ||
      !Number.isFinite(contract.price) ||
      contract.price < 0
    ) {
      return "A saved option premium for the selected index is required.";
    }
    if (simulationDraft.definition.legs.length >= 12) {
      return "Remove a position before adding another leg (maximum 12).";
    }
    if (
      simulationDraft.definition.legs.some(
        (leg) => leg.expiryDate !== option.expiryDate,
      )
    ) {
      return "Use one expiry per simulator basket.";
    }
    setSimulationDraft((previous) => ({
      savedId: "",
      definition: {
        ...previous.definition,
        legs: [
          ...previous.definition.legs,
          {
            stockCode: underlying,
            expiryDate: option.expiryDate,
            strikePrice: option.strikePrice,
            right: option.right,
            side,
            quantity: contract.lotSize,
          },
        ],
      },
      marketReferences: [
        ...(previous.marketReferences ?? []),
        {
          stockCode: underlying,
          expiryDate: option.expiryDate,
          strikePrice: option.strikePrice,
          right: option.right,
          price: contract.price as number,
        },
      ],
    }));
    return "";
  };
  const [reference, setReference] = useState<{
    spot: number;
    day?: string;
  } | null>(null);
  /** Bind payoff assumptions to the exact option-chain observation. */
  const onReferenceData = useCallback(
    (value: { spot: number; day?: string }) => setReference(value),
    [],
  );
  const feed = useMarketFeed(csrf, Boolean(underlying) && dataMode === "live");
  return (
    <div
      className={`screen-stack ${experience === "simulator" ? styles.simulator : ""}`}
    >
      <section
        className={`panel screen-card market-workspace-toolbar ${styles.commandPanel}`}
      >
        {experience === "simulator" && (
          <div className={styles.replayToolbar}>
            <label title="Index">
              <select
                aria-label="Simulator index"
                value={underlying}
                onChange={(event) => {
                  setUnderlying(event.target.value);
                  setSimulationDraft({
                    savedId: "",
                    definition: createResearchDefinition("options"),
                  });
                  setReference(null);
                }}
              >
                {[
                  "NIFTY",
                  "BANKNIFTY",
                  "FINNIFTY",
                  "MIDCPNIFTY",
                  "NIFTYNXT50",
                  "SENSEX",
                  "BANKEX",
                ].map((symbol) => (
                  <option key={symbol}>{symbol}</option>
                ))}
              </select>
            </label>
            <label title="Replay data available on or before this date">
              <input
                aria-label="Replay date"
                type="date"
                value={asOf}
                max={exchangeDay()}
                onChange={(event) => {
                  setAsOf(event.target.value);
                  setSimulationDraft({
                    savedId: "",
                    definition: createResearchDefinition("options"),
                  });
                  setReference(null);
                }}
              />
            </label>
            <span
              className={styles.dataLabel}
              role="status"
              title={`Stored as of ${reference?.day ?? asOf}. Saved index-option observations only. Minute replay, broker connections and live orders are unavailable in replay mode.`}
            >
              Stored
            </span>
          </div>
        )}
        {experience === "simulator" ? null : underlying ? (
          <div className="screen-toolbar">
            <p>
              <strong>{underlying}</strong> ·{" "}
              {dataMode === "live"
                ? "active broker live data"
                : "stored database snapshot"}
            </p>
            <Button variant="secondary" onClick={() => setUnderlying("")}>
              Change scrip
            </Button>
          </div>
        ) : (
          <UnderlyingSearch
            csrf={csrf}
            selected={underlying}
            onSelect={(symbol) => {
              setReference(null);
              setUnderlying(symbol);
            }}
            experience={experience}
          />
        )}
      </section>
      {underlying && (
        <div
          className={`strategy-market-workspace ${experience === "simulator" ? styles.workspace : ""}`}
        >
          <div className="strategy-market-chain">
            {feed.error && dataMode === "live" && (
              <p role="alert" className="error">
                {feed.error}
              </p>
            )}
            <LiveOptionChain
              key={`${experience}:${asOf}:${underlying}`}
              selectedUnderlying={underlying}
              csrf={csrf}
              ticks={feed.ticks}
              onAddLeg={
                experience === "simulator" ? addSimulationLeg : onAddLeg
              }
              activeLegs={
                (experience === "simulator" ? simulationDraft : draft)
                  ?.definition.legs ?? []
              }
              onDataMode={setDataMode}
              onReferenceData={onReferenceData}
              experience={experience}
              asOf={experience === "simulator" ? asOf : undefined}
              compact
            />
          </div>
          <div className="strategy-market-payoff">
            <OptionsPayoffBuilder
              key={
                experience === "simulator" ? `${underlying}:${asOf}` : "builder"
              }
              simulator={experience === "simulator"}
              csrf={csrf}
              draft={experience === "simulator" ? simulationDraft : draft}
              initialUnderlying={underlying}
              valuationDate={experience === "simulator" ? asOf : undefined}
              referenceSpot={reference?.spot}
              referenceDay={reference?.day}
            />
          </div>
        </div>
      )}
    </div>
  );
}
