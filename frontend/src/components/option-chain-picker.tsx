"use client";

/** Read-only, explicit-expiry option-chain picker. Prices are indicative, not trade authorization.
 * It adds/replaces a research leg only; the parent must save before quoting or simulating.
 */
import { useState } from "react";
import { KotakOptionChain } from "./kotak-option-chain";
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
      <KotakOptionChain
        csrf={csrf}
        disabled={disabled}
        selectionLabel="Use research contract"
        onSelect={(item) => {
          if (!item.option || (index === legCount && legCount >= 4)) {
            return;
          }
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
      <p>
        Selection starts at one lot. Review side and quantity in the builder.
        This selection creates research inputs only; it cannot submit an order.
      </p>
    </section>
  );
}
