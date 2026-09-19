"use client";
/** Debounced transport for Python payoff/risk calculations; React only renders validated output. */
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { requestApiJson } from "@/lib/api";

export type PayoffLegInput = {
  right: "call" | "put";
  side: "buy" | "sell";
  strike: number;
  quantity: number;
  premium: number;
  iv: number;
};
export type PayoffCalculationInput = {
  legs: PayoffLegInput[];
  spot: number;
  days: number;
  rate: number;
  dividend: number;
  ivShift: number;
  targetSpot: number;
  totalFees: number;
};
const finite = z.number().finite();
const payoffResultSchema = z
  .object({
    engineVersion: z.string().min(1),
    result: z
      .object({
        netDebit: finite,
        risk: z
          .object({
            maxProfit: finite.nullable(),
            maxLoss: finite.nonnegative().nullable(),
            unlimitedProfit: z.boolean(),
            unlimitedLoss: z.boolean(),
            breakevens: z.array(finite.nonnegative()),
          })
          .strict(),
        low: finite.positive(),
        high: finite.positive(),
        points: z.array(
          z
            .object({
              spot: finite.positive(),
              expiry: finite,
              scenario: finite,
            })
            .strict(),
        ),
        target: z
          .object({
            pnl: finite,
            delta: finite,
            gamma: finite,
            theta: finite,
            vega: finite,
          })
          .strict(),
        targetExpiry: finite,
      })
      .strict(),
  })
  .strict();
export type PayoffCalculation = z.infer<typeof payoffResultSchema>["result"];

/** Recalculate after a short edit pause and abort every superseded request. */
export function usePayoffCalculation(
  csrf: string,
  input: PayoffCalculationInput | null,
) {
  const [resolved, setResolved] = useState<{
    key: string;
    value: PayoffCalculation | null;
  }>({ key: "", value: null });
  const [failure, setFailure] = useState({ key: "", message: "" });
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const serialized = input ? JSON.stringify(input) : "";
  useEffect(() => {
    const current = ++generation.current;
    setLoading(Boolean(input));
    if (!input) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void requestApiJson(
        "/calculations/payoff",
        "POST",
        input,
        csrf,
        30000,
        controller.signal,
      )
        .then((raw) => payoffResultSchema.parse(raw))
        .then((response) => {
          if (current === generation.current) {
            setResolved({ key: serialized, value: response.result });
            setFailure({ key: "", message: "" });
          }
        })
        .catch((cause) => {
          if (current === generation.current && !controller.signal.aborted) {
            setFailure({
              key: serialized,
              message:
                cause instanceof Error
                  ? cause.message
                  : "Payoff calculation failed.",
            });
          }
        })
        .finally(() => {
          if (current === generation.current) {
            setLoading(false);
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The canonical serialized payload is the dependency; callers replace immutable input objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csrf, serialized]);
  return {
    result: resolved.key === serialized ? resolved.value : null,
    error: failure.key === serialized ? failure.message : "",
    loading,
  };
}
