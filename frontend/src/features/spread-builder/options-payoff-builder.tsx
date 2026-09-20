"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import type { ResearchDraft } from "@/features/research/research-draft";
import {
  usePayoffCalculation,
  type PayoffCalculationInput,
  type PayoffLegInput,
} from "./use-payoff-calculation";
import { PayoffGraph } from "./payoff-graph";
import styles from "./options-builder.module.css";
import { requestApiJson } from "@/lib/api";
import { storedInstrumentSearchSchema } from "@/lib/stored-market-data";
import { useUnsavedResearchWarning } from "@/features/workspace/workspace-views";

type EditorLeg = {
  id: string;
  enabled: boolean;
  right: "call" | "put";
  side: "buy" | "sell";
  strike: string;
  lots: string;
  lotSize: string;
  premium: string;
  iv: string;
};
/** Enabled editor positions drive chain highlighting, including manual side changes. */
export type PayoffSelection = {
  stockCode: string;
  expiryDate: string;
  strikePrice: number;
  right: "call" | "put";
  side: "buy" | "sell";
};
/** Create one blank client-only editor row; no price or contract is invented. */
const freshLeg = (): EditorLeg => ({
  id: crypto.randomUUID(),
  enabled: true,
  right: "call",
  side: "buy",
  strike: "",
  lots: "1",
  lotSize: "",
  premium: "",
  iv: "20",
});
/** Format finite rupee results while preserving analytic unbounded tails. */
const money = (n: number | null) =>
  n === null
    ? "Unlimited"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
      }).format(n);
/** Parse an editable numeric field without substituting a missing value. */
const number = (value: string) => (value.trim() ? Number(value) : NaN);
/** Produce an exchange-independent ISO date for empty scenario controls. */
const day = (offset = 0) =>
  new Date(Date.now() + 19800000 + offset * 86400000)
    .toISOString()
    .slice(0, 10);
const daySchema = z.iso.date();

/** Editable scenario assumptions are calculated by Python and never enter order execution. */
export function OptionsPayoffBuilder({
  csrf,
  draft,
  initialUnderlying,
  valuationDate,
  referenceSpot,
  referenceDay,
  onSelectionChange,
}: {
  csrf: string;
  draft?: ResearchDraft;
  initialUnderlying?: string;
  valuationDate?: string;
  referenceSpot?: number;
  referenceDay?: string;
  onSelectionChange?: (legs: PayoffSelection[]) => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [spot, setSpot] = useState("");
  const [asOf, setAsOf] = useState(() => day());
  const [expiry, setExpiry] = useState("");
  const [rate, setRate] = useState("7");
  const [dividend, setDividend] = useState("0");
  const [legs, setLegs] = useState<EditorLeg[]>([]);
  useUnsavedResearchWarning(legs.length > 0);
  useEffect(() => {
    onSelectionChange?.(
      legs
        .filter((leg) => leg.enabled)
        .map((leg) => ({
          stockCode: symbol,
          expiryDate: expiry,
          strikePrice: Number(leg.strike),
          right: leg.right,
          side: leg.side,
        })),
    );
  }, [legs, symbol, expiry, onSelectionChange]);
  const [target, setTarget] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [ivShift, setIvShift] = useState(0);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("graph");
  const sourceIds = useRef(new WeakMap<object, string>());
  const removedIds = useRef(new Set<string>());
  /** Resolve the selected scrip's last real stored close at the replay cutoff.
   * A missing stored candle leaves spot blank; option premiums are never derived
   * from this underlying value.
   */
  useEffect(() => {
    if (!initialUnderlying) {
      return;
    }
    const controller = new AbortController();
    setSymbol(initialUnderlying);
    setSpot("");
    if (
      typeof referenceSpot === "number" &&
      Number.isFinite(referenceSpot) &&
      referenceSpot > 0
    ) {
      setSpot(String(referenceSpot));
      setAsOf(referenceDay ?? valuationDate ?? day());
      setTarget("");
      return;
    }
    void (async () => {
      try {
        const search = storedInstrumentSearchSchema.parse(
          await requestApiJson(
            `/eod/instruments?q=${encodeURIComponent(initialUnderlying)}&offset=0`,
            "GET",
            undefined,
            undefined,
            15000,
            controller.signal,
          ),
        );
        const instrument = search.items
          .filter(
            (item) =>
              item.symbol === initialUnderlying &&
              (!valuationDate || item.first_day <= valuationDate),
          )
          .sort((left, right) =>
            right.last_day.localeCompare(left.last_day),
          )[0];
        if (!instrument) {
          return;
        }
        const selectedDay =
          valuationDate && valuationDate < instrument.last_day
            ? valuationDate
            : instrument.last_day;
        const history = await requestApiJson(
          `/eod/candles?id=${encodeURIComponent(instrument.id)}&to=${selectedDay}`,
          "GET",
          undefined,
          undefined,
          15000,
          controller.signal,
        );
        const candle = Array.isArray(history.candles)
          ? history.candles.at(-1)
          : undefined;
        if (!controller.signal.aborted && candle?.close > 0) {
          setSpot(String(candle.close));
          setAsOf(String(candle.day));
          setTarget("");
        }
      } catch {
        // The editor remains explicit when stored underlying history is absent.
      }
    })();
    return () => controller.abort();
  }, [initialUnderlying, valuationDate, referenceSpot, referenceDay]);
  /** Apply one immutable leg edit so memoized validation sees a new basket. */
  function edit(id: string, patch: Partial<EditorLeg>) {
    setLegs((rows) =>
      rows.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)),
    );
  }
  /** Mirror chain selections immediately so the table and payoff share one basket. */
  useEffect(() => {
    if (!draft) {
      return;
    }
    const source = draft?.definition.legs ?? [];
    if (!source.length) {
      setLegs([]);
      setNotice(
        "Choose B or S beside an option-chain price to add a position.",
      );
      return;
    }
    if (
      source.some(
        (leg) =>
          leg.stockCode !== source[0].stockCode ||
          leg.expiryDate !== source[0].expiryDate,
      )
    ) {
      setNotice(
        "Choose contracts with one underlying and one expiry for this builder.",
      );
      return;
    }
    setSymbol(source[0].stockCode);
    setExpiry(source[0].expiryDate?.slice(0, 10) ?? "");
    setLegs((previous) =>
      source
        .slice(0, 12)
        .map((leg) => {
          let id = sourceIds.current.get(leg);
          if (!id) {
            id = crypto.randomUUID();
            sourceIds.current.set(leg, id);
          }
          const existing = previous.find((row) => row.id === id);
          if (existing) {
            return existing;
          }
          const reference = draft?.marketReferences?.find(
            (item) =>
              item.stockCode === leg.stockCode &&
              item.expiryDate === leg.expiryDate &&
              item.right === leg.right &&
              item.strikePrice === leg.strikePrice,
          );
          return {
            ...freshLeg(),
            id,
            right: leg.right ?? "call",
            side: leg.side,
            strike: String(leg.strikePrice ?? ""),
            lotSize: leg.quantity > 0 ? String(leg.quantity) : "",
            lots: "1",
            premium: reference ? String(reference.price) : "",
          };
        })
        .filter((leg) => !removedIds.current.has(leg.id)),
    );
    setElapsed(0);
    setNotice(
      draft?.marketReferences?.length
        ? "Position updated from the adjacent option chain. Displayed premiums remain simulation inputs only."
        : "Contract units copied as one position per leg. Enter spot, premiums and IV; no quotes were assumed.",
    );
  }, [draft, initialUnderlying]);
  const prepared = useMemo(
    /** Convert editable strings into the bounded Python contract without pricing locally. */ () => {
      const invalid = (error: string) => ({
        error,
        input: null,
        basket: [] as PayoffLegInput[],
        targetSpot: 0,
        days: 0,
        remaining: 0,
      });
      try {
        if (!legs.some((leg) => leg.enabled)) {
          return invalid("Add a leg to start building your payoff.");
        }
        if (!symbol.trim()) {
          return invalid("Enter an underlying name.");
        }
        if (
          !daySchema.safeParse(asOf).success ||
          !daySchema.safeParse(expiry).success
        ) {
          return invalid("Choose a valuation date and a common expiry.");
        }
        const days = (Date.parse(expiry) - Date.parse(asOf)) / 86400000;
        if (days < 0 || days > 3650) {
          return invalid(
            "Expiry must be on or after valuation date, within ten years.",
          );
        }
        const s = number(spot),
          r = number(rate) / 100,
          q = number(dividend) / 100;
        if (
          !Number.isFinite(s) ||
          s <= 0 ||
          s > 1e7 ||
          !Number.isFinite(r) ||
          Math.abs(r) > 1 ||
          !Number.isFinite(q) ||
          q < 0 ||
          q > 1
        ) {
          return invalid(
            "Enter a positive spot and valid rate/dividend assumptions.",
          );
        }
        const basket: PayoffLegInput[] = legs
          .filter((leg) => leg.enabled)
          .map((leg) => ({
            side: leg.side,
            right: leg.right,
            strike: number(leg.strike),
            quantity: number(leg.lots) * number(leg.lotSize),
            premium: number(leg.premium),
            iv: number(leg.iv) / 100,
          }));
        if (
          legs
            .filter((leg) => leg.enabled)
            .some(
              (leg) =>
                !Number.isSafeInteger(number(leg.lots)) ||
                number(leg.lots) < 1 ||
                !Number.isSafeInteger(number(leg.lotSize)) ||
                number(leg.lotSize) < 1,
            ) ||
          basket.some(
            (leg) =>
              !Number.isFinite(leg.iv) ||
              leg.iv < 0 ||
              leg.iv > 4 ||
              leg.quantity > 1e7,
          )
        ) {
          return invalid(
            "Lots and lot size must be positive integers; IV must be 0–400%.",
          );
        }
        const remaining = days - Math.min(days, elapsed);
        const targetSpot = target.trim() ? number(target) : s;
        if (!Number.isFinite(targetSpot) || targetSpot <= 0) {
          return invalid("Enter a positive target price.");
        }
        // Mirror the calculator's accepted display grid for immediate form feedback;
        // Python remains authoritative and validates direct API requests too.
        const low = Math.max(
          0.01,
          Math.min(s * 0.8, ...basket.map((leg) => leg.strike * 0.9)),
        );
        const high = Math.max(
          s * 1.2,
          ...basket.map((leg) => leg.strike * 1.1),
        );
        if (targetSpot < low || targetSpot > high) {
          return invalid(
            `Target price must be between ${low.toFixed(2)} and ${high.toFixed(2)}.`,
          );
        }
        const input: PayoffCalculationInput = {
          legs: basket,
          spot: s,
          days: remaining,
          rate: r,
          dividend: q,
          ivShift: ivShift / 100,
          targetSpot,
          totalFees: 0,
        };
        return {
          input,
          basket,
          targetSpot,
          days,
          remaining,
          error: "",
        };
      } catch {
        return invalid(
          "Complete each enabled leg with a positive strike, valid units and a non-negative premium.",
        );
      }
    },
    [
      legs,
      symbol,
      asOf,
      expiry,
      spot,
      rate,
      dividend,
      elapsed,
      ivShift,
      target,
    ],
  );
  const remote = usePayoffCalculation(csrf, prepared.input);
  const calculation = {
    ...prepared,
    debit: remote.result?.netDebit ?? null,
    analysis: remote.result,
    scenario: remote.result?.target ?? null,
    error:
      prepared.error ||
      remote.error ||
      (remote.loading ? "Calculating with Python…" : ""),
  };
  const result = calculation.analysis ? calculation : null;
  return (
    <section className={styles.builder} aria-label="Options payoff builder">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>OPTIONS WORKSPACE</p>
          <h2>Build a strategy. Explore its payoff.</h2>
        </div>
        <span className="badge">SIMULATION ONLY</span>
      </div>
      <article className={`${styles.panel} ${styles.positionsPanel}`}>
        <div className={styles.header}>
          <h3>Strategy legs</h3>
          <span className={styles.muted}>Use B / S in the option chain</span>
        </div>
        <div className={`${styles.fields} ${styles.contractFields}`}>
          <label>
            Underlying
            <input
              aria-label="Payoff underlying"
              placeholder="e.g. NIFTY"
              value={symbol}
              maxLength={60}
              onChange={(e) => setSymbol(e.target.value)}
            />
          </label>
          <label>
            Spot price (₹)
            <input
              aria-label="Payoff spot price"
              type="number"
              min="0.01"
              step="0.01"
              value={spot}
              onChange={(e) => {
                setSpot(e.target.value);
                setTarget("");
              }}
            />
          </label>
          <label>
            Valuation date
            <input
              type="date"
              aria-label="Valuation date"
              value={asOf}
              onChange={(e) => {
                setAsOf(e.target.value);
                setElapsed(0);
              }}
            />
          </label>
          <label>
            Common expiry
            <input
              type="date"
              aria-label="Common expiry"
              value={expiry}
              onChange={(e) => {
                setExpiry(e.target.value);
                setElapsed(0);
              }}
            />
          </label>
        </div>
        {notice && (
          <p
            role="status"
            className={`${styles.muted} ${styles.positionNotice}`}
          >
            {notice}
          </p>
        )}
        <div className={styles.tableScroll}>
          <table className={styles.legs}>
            <thead>
              <tr>
                <th>Use</th>
                <th>Side</th>
                <th>Type</th>
                <th>Strike</th>
                <th>Lots</th>
                <th>Lot size</th>
                <th>Premium ₹</th>
                <th>IV %</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, i) => (
                <tr
                  key={leg.id}
                  className={leg.side === "buy" ? styles.buy : styles.sell}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Enable leg ${i + 1}`}
                      checked={leg.enabled}
                      onChange={(e) =>
                        edit(leg.id, { enabled: e.target.checked })
                      }
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Side leg ${i + 1}`}
                      value={leg.side}
                      onChange={(e) =>
                        edit(leg.id, { side: e.target.value as "buy" | "sell" })
                      }
                    >
                      <option value="buy">Buy</option>
                      <option value="sell">Sell</option>
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Type leg ${i + 1}`}
                      value={leg.right}
                      onChange={(e) =>
                        edit(leg.id, {
                          right: e.target.value as "call" | "put",
                        })
                      }
                    >
                      <option value="call">CE</option>
                      <option value="put">PE</option>
                    </select>
                  </td>
                  {(
                    ["strike", "lots", "lotSize", "premium", "iv"] as const
                  ).map((field) => (
                    <td key={field}>
                      <input
                        type="number"
                        aria-label={`${field} leg ${i + 1}`}
                        value={leg[field]}
                        min={
                          field === "iv" || field === "premium"
                            ? 0
                            : field === "strike"
                              ? 0.01
                              : 1
                        }
                        step={
                          field === "lots" || field === "lotSize" ? 1 : 0.01
                        }
                        onChange={(e) =>
                          edit(leg.id, { [field]: e.target.value })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className={styles.icon}
                      aria-label={`Remove leg ${i + 1}`}
                      onClick={() => {
                        removedIds.current.add(leg.id);
                        setLegs((rows) =>
                          rows.filter((row) => row.id !== leg.id),
                        );
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={`${styles.header} ${styles.positionFooter}`}>
          <Button
            variant="secondary"
            disabled={legs.length >= 12}
            onClick={() => setLegs((rows) => [...rows, freshLeg()])}
          >
            <Plus size={15} /> Add leg
          </Button>
          <span className={styles.muted}>
            {legs.filter((leg) => leg.enabled).length} active legs · one
            underlying / expiry · units = lots × lot size
          </span>
        </div>
      </article>
      <div className={styles.split}>
        <article className={styles.panel}>
          <div className={styles.header}>
            <h3>Payoff analysis</h3>
            <select
              aria-label="Payoff view"
              style={{ width: "auto" }}
              value={view}
              onChange={(e) => setView(e.target.value)}
            >
              <option value="graph">Payoff graph</option>
              <option value="matrix">Scenario table</option>
            </select>
          </div>
          {result?.analysis && result.basket ? (
            <>
              <div className={styles.metrics}>
                <div className={styles.metric}>
                  Max profit at expiry
                  <strong className={styles.positive}>
                    {money(result.analysis.risk.maxProfit)}
                  </strong>
                </div>
                <div className={styles.metric}>
                  Max loss at expiry
                  <strong className={styles.negative}>
                    {money(result.analysis.risk.maxLoss)}
                  </strong>
                </div>
                <div className={styles.metric}>
                  Net {result.debit! >= 0 ? "debit" : "credit"}
                  <strong>{money(Math.abs(result.debit!))}</strong>
                </div>
              </div>
              <div className={styles.legend}>
                <span>━ Expiry payoff</span>
                {result.analysis.target && (
                  <span style={{ color: "#6366f1" }}>
                    ┄ Target-date estimate
                  </span>
                )}
                <span className={styles.muted}>Before costs</span>
              </div>
              {view === "graph" ? (
                <PayoffGraph
                  points={result.analysis.points}
                  target={result.targetSpot!}
                  onTarget={(s) => setTarget(String(s))}
                />
              ) : (
                <div className={styles.tableScroll}>
                  <table aria-label="Payoff scenario table">
                    <thead>
                      <tr>
                        <th>Underlying ₹</th>
                        <th>Expiry P&amp;L</th>
                        <th>Target-date P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.analysis.points
                        .filter((_, i) => i % 10 === 0)
                        .map((p) => (
                          <tr key={p.spot}>
                            <td>{money(p.spot)}</td>
                            <td
                              className={
                                p.expiry >= 0
                                  ? styles.positive
                                  : styles.negative
                              }
                            >
                              {money(p.expiry)}
                            </td>
                            <td
                              className={
                                (p.scenario ?? 0) >= 0
                                  ? styles.positive
                                  : styles.negative
                              }
                            >
                              {p.scenario === null
                                ? "Unavailable"
                                : money(p.scenario)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className={styles.muted}>
                Breakeven at expiry:{" "}
                {result.analysis.risk.breakevens.map(money).join(" · ") ||
                  "None"}
              </p>
            </>
          ) : (
            <div className={styles.empty}>
              <h3>Your payoff appears here</h3>
              <p role="status" className={styles.muted}>
                {calculation.error}
              </p>
            </div>
          )}
        </article>
        <details
          className={`${styles.panel} ${styles.scenarioPanel}`}
          aria-label="Scenario controls"
        >
          <summary>Payoff settings and Greeks</summary>
          <div className={styles.scenarioBody}>
            <div>
              <p className={styles.eyebrow}>WHAT IF?</p>
              <h3>Target scenario</h3>
            </div>
            <label>
              Target price (₹)
              <input
                aria-label="Target price"
                type="number"
                step="0.01"
                value={target || spot}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            {calculation.analysis && (
              <input
                aria-label="Target price slider"
                type="range"
                min={calculation.analysis.low}
                max={calculation.analysis.high}
                step="0.01"
                value={number(target || spot)}
                onChange={(e) => setTarget(e.target.value)}
              />
            )}
            <label>
              Days passed: {Math.min(elapsed, calculation.days ?? 0)} /{" "}
              {calculation.days ?? 0}
              <input
                aria-label="Days passed"
                type="range"
                min="0"
                max={calculation.days ?? 0}
                step="1"
                disabled={calculation.days === undefined}
                value={Math.min(elapsed, calculation.days ?? 0)}
                onChange={(e) => setElapsed(Number(e.target.value))}
              />
            </label>
            <label>
              IV change: {ivShift > 0 ? "+" : ""}
              {ivShift} percentage points
              <input
                aria-label="IV change"
                type="range"
                min="-20"
                max="20"
                step="0.5"
                value={ivShift}
                onChange={(e) => setIvShift(Number(e.target.value))}
              />
            </label>
            <div className={styles.target}>
              <span className={styles.muted}>
                Estimated target-date P&amp;L
              </span>
              <strong
                className={
                  (result?.scenario?.pnl ?? 0) >= 0
                    ? styles.positive
                    : styles.negative
                }
              >
                {result?.scenario ? money(result.scenario.pnl) : "—"}
              </strong>
              <span className={styles.muted}>
                Expiry at target:{" "}
                {result?.analysis ? money(result.analysis.targetExpiry) : "—"}
              </span>
            </div>
            <div
              className={styles.fields}
              style={{ gridTemplateColumns: "1fr 1fr" }}
            >
              {(["delta", "gamma", "theta", "vega"] as const).map((key) => (
                <div className={styles.metric} key={key}>
                  {key === "theta"
                    ? "Theta / day"
                    : key === "vega"
                      ? "Vega / 1% IV"
                      : key}
                  <strong>
                    {result?.scenario && result.remaining! > 0
                      ? result.scenario[key].toFixed(key === "gamma" ? 4 : 2)
                      : "—"}
                  </strong>
                </div>
              ))}
            </div>
            <details>
              <summary>Model assumptions</summary>
              <div
                className={styles.fields}
                style={{ gridTemplateColumns: "1fr 1fr", marginTop: 12 }}
              >
                <label>
                  Risk-free rate %
                  <input
                    aria-label="Risk-free rate"
                    type="number"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                  />
                </label>
                <label>
                  Dividend yield %
                  <input
                    aria-label="Dividend yield"
                    type="number"
                    min="0"
                    value={dividend}
                    onChange={(e) => setDividend(e.target.value)}
                  />
                </label>
              </div>
              <p className={styles.muted}>
                European Black–Scholes, calendar days / 365, constant IV per
                leg. Negative shifted IV is floored at zero. Greeks are
                quantity-weighted at the target scenario. No fees, taxes,
                slippage, margin or execution modeling. These are estimates, not
                broker quotes. Manual drafts last only while this builder
                remains open.
              </p>
            </details>
          </div>
        </details>
      </div>
    </section>
  );
}
