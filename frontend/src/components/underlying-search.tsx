"use client";
/** Search cached broker metadata; choosing an underlying is the only trigger for chain prices. */
import { useEffect, useId, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import styles from "./underlying-search.module.css";

export function UnderlyingSearch({
  csrf,
  selected,
  onSelect,
  experience,
  asOf,
}: {
  csrf: string;
  selected: string;
  onSelect: (symbol: string) => void;
  experience?: "builder";
  asOf?: string;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  useEffect(() => {
    if (selected || query.trim().length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const result = await requestApiJson(
          "/market/instruments",
          "POST",
          {
            market: "options",
            query,
            offset: 0,
            ...(experience ? { experience } : {}),
            ...(asOf ? { asOf } : {}),
          },
          csrf,
          60000,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setMatches(
            [...result.underlyings].sort(
              (left: string, right: string) =>
                Number(right === query.trim().toUpperCase()) -
                  Number(left === query.trim().toUpperCase()) ||
                left.localeCompare(right),
            ),
          );
          setError(
            result.underlyings.length
              ? ""
              : experience
                ? "No stored option-chain data matches this scrip. Cash-price history alone is not enough. Import its F&O option data or capture its broker chain during market hours."
                : "No listed options match this search.",
          );
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Search unavailable.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [csrf, query, selected, experience, asOf]);
  return (
    <section aria-label="Search option underlying" className={styles.panel}>
      <Field
        label="Search scrip"
        htmlFor={inputId}
        hint="Type at least two characters, then choose a scrip. Prices load only after selection."
      >
        <Input
          id={inputId}
          value={query}
          maxLength={40}
          placeholder="Type REL, NIFTY, BANK…"
          onChange={(event) => {
            setQuery(event.target.value.toUpperCase());
            setMatches([]);
            setError("");
            setBusy(false);
            onSelect("");
          }}
        />
      </Field>
      {busy && (
        <p className={styles.status} role="status">
          Searching scrips…
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!selected && matches.length > 0 && (
        <div className={styles.matches}>
          {matches.map((symbol) => (
            <Button
              key={symbol}
              variant="secondary"
              onClick={() => {
                setQuery(symbol);
                onSelect(symbol);
              }}
            >
              {symbol}
            </Button>
          ))}
        </div>
      )}
      {selected && (
        <p className={styles.status} role="status">
          Selected: {selected}
        </p>
      )}
    </section>
  );
}
