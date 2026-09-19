"use client";
/** Search cached broker metadata; choosing an underlying is the only trigger for chain prices. */
import { useEffect, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "./ui/button";

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
  experience?: "builder" | "simulator";
  asOf?: string;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
          setMatches(result.underlyings);
          setError(
            result.underlyings.length
              ? ""
              : experience
                ? "No stored scrip matches this search."
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
    <section
      aria-label="Search option underlying"
      className="panel screen-card"
    >
      <label>
        Search scrip
        <input
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
      </label>
      <p>
        Type at least two characters, then choose a scrip. Prices load only
        after selection.
      </p>
      {busy && <p role="status">Searching scrips…</p>}
      {error && <p role="alert">{error}</p>}
      {!selected &&
        matches.map((symbol) => (
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
      {selected && <p role="status">Selected: {selected}</p>}
    </section>
  );
}
