"use client";

/** Read-only, explicit-expiry option-chain picker. Prices are indicative, not trade authorization.
 * It adds/replaces a research leg only; the parent must save before quoting or simulating.
 */
import { useState } from "react";
import { InstrumentPicker, type BrokerInstrument } from "./instrument-picker";
import { useMarketFeed } from "@/features/option-chain/use-market-feed";
import { requestApiJson } from "@/lib/api";
type Leg = {
  stockCode: string;
  expiryDate: string;
  right: "call" | "put";
  strikePrice: number;
  side: "buy" | "sell";
  quantity: number;
};

/** Map a normalized catalog selection to a research leg; never submit an order. */
export function OptionChainPicker({
  csrf,
  legCount,
  disabled,
  onSelect,
}: {
  csrf: string;
  legCount: number;
  disabled: boolean;
  onSelect: (leg: Leg, index: number) => void;
}) {
  const [target, setTarget] = useState(0);
  const [selected, setSelected] = useState<BrokerInstrument | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const feed = useMarketFeed(csrf, Boolean(selected));
  const quote = selected
    ? feed.ticks.find(
        (tick) =>
          tick.exchange === "nse_fo" &&
          String(tick.instrument) === selected.instrument,
      )
    : undefined;
  const index = Math.min(target, legCount);
  return (
    <section className="research-chain" aria-label="Option chain picker">
      <label>
        Apply Kotak contract to
        <select
          disabled={disabled}
          value={index}
          onChange={(event) => setTarget(Number(event.target.value))}
        >
          {Array.from({ length: legCount }, (_, i) => (
            <option key={i} value={i}>
              Replace leg {i + 1}
            </option>
          ))}
          <option value={legCount} disabled={legCount >= 4}>
            Add new leg
          </option>
        </select>
      </label>
      <InstrumentPicker
        market="options"
        csrf={csrf}
        disabled={disabled}
        onClear={() => {
          setSelected(null);
          setQuoteError("");
        }}
        onSelect={(item) => {
          if (!item.option || (index === legCount && legCount >= 4)) {
            return;
          }
          setSelected(item);
          setQuoteError("");
          // Subscribe only the explicitly selected contract; search results never fetch quotes.
          void requestApiJson(
            "/market/live-feed",
            "POST",
            { instruments: [item.instrument] },
            csrf,
            95000,
          ).catch((cause) =>
            setQuoteError(
              cause instanceof Error ? cause.message : "Quote unavailable.",
            ),
          );
          onSelect(
            {
              stockCode: item.symbol,
              ...item.option,
              side: "buy",
              quantity: item.lotSize,
            },
            index,
          );
        }}
      />
      {selected && (
        <p role="status">
          {selected.name} · Last price{" "}
          {typeof quote?.ltp === "number"
            ? `₹${quote.ltp.toFixed(2)}`
            : "Loading…"}
          {quote && !quote.receivedRecently ? " · Last known price" : ""}
        </p>
      )}
      {selected && (quoteError || feed.error) && (
        <p role="alert">{quoteError || feed.error}</p>
      )}
      <p>
        Selection starts at one lot. Review side and quantity in the builder.
        This selection creates research inputs only; it cannot submit an order.
      </p>
    </section>
  );
}
