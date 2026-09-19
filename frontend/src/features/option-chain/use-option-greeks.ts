"use client";

/** Debounced broker-neutral transport for Python-derived option-chain Greeks. */
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { requestApiJson } from "@/lib/api";
import type { ChainContract } from "./use-option-chain";

const finite = z.number().finite();
const greekValue = z
  .object({
    key: z.string().min(1).max(160),
    impliedVolatility: finite.nullable(),
    delta: finite.nullable(),
    gamma: finite.nullable(),
    theta: finite.nullable(),
    vega: finite.nullable(),
  })
  .strict();
const responseSchema = z
  .object({
    engineVersion: z.string().min(1),
    result: z
      .object({
        model: z.literal("black-76-synthetic-forward-v1"),
        items: z.array(greekValue).max(200),
      })
      .strict(),
  })
  .strict();
export type OptionGreekValue = z.infer<typeof greekValue>;

/** Convert exchange calendar dates into a positive Black–Scholes time horizon. */
function calendarDays(expiry: string, valuationDate: string): number {
  const milliseconds =
    Date.parse(`${expiry}T00:00:00Z`) -
    Date.parse(`${valuationDate}T00:00:00Z`);
  return Math.max(0.25, milliseconds / 86_400_000);
}

/** Calculate Greeks from the currently displayed premiums without exposing broker sessions. */
export function useOptionGreeks(
  csrf: string,
  input: {
    spot?: number | null;
    expiry: string;
    valuationDate: string;
    contracts: ChainContract[];
  },
) {
  const generation = useRef(0);
  const [resolved, setResolved] = useState<{
    key: string;
    items: OptionGreekValue[];
  }>({ key: "", items: [] });
  const [failure, setFailure] = useState({ key: "", message: "" });
  const payload = useMemo(() => {
    if (!input.spot || input.spot <= 0 || !input.expiry) {
      return null;
    }
    const contracts = input.contracts.flatMap((contract) =>
      contract.option &&
      typeof contract.price === "number" &&
      contract.price > 0
        ? [
            {
              key: contract.instrument,
              right: contract.option.right,
              strike: contract.option.strikePrice,
              premium: contract.price,
            },
          ]
        : [],
    );
    return contracts.length
      ? {
          spot: input.spot,
          days: calendarDays(input.expiry, input.valuationDate),
          rate: 0.065,
          dividend: 0,
          contracts,
        }
      : null;
  }, [input.contracts, input.expiry, input.spot, input.valuationDate]);
  const serialized = payload ? JSON.stringify(payload) : "";

  /** Abort superseded batches so a previous price snapshot cannot replace newer Greeks. */
  useEffect(() => {
    const current = ++generation.current;
    if (!payload) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void requestApiJson(
        "/calculations/option-greeks",
        "POST",
        payload,
        csrf,
        30_000,
        controller.signal,
      )
        .then((raw) => responseSchema.parse(raw))
        .then((response) => {
          if (current === generation.current) {
            setResolved({ key: serialized, items: response.result.items });
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
                  : "Option Greeks are unavailable.",
            });
          }
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [csrf, payload, serialized]);

  return {
    values: useMemo(
      () =>
        new Map(
          (resolved.key === serialized ? resolved.items : []).map((item) => [
            item.key,
            item,
          ]),
        ),
      [resolved, serialized],
    ),
    error: failure.key === serialized ? failure.message : "",
  };
}
