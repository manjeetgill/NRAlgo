"use client";
/** Shared stored-history picker; watchlists additionally browse the full current NSE catalogue. */
import { useEffect, useId, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { z } from "zod";
import {
  storedInstrumentSchema,
  storedInstrumentSearchSchema,
  type StoredInstrument,
  type StoredInstrumentSearch,
} from "@/lib/stored-market-data";
export type { StoredInstrument } from "@/lib/stored-market-data";

// Watchlists may include a new listing before its first valid candle is published.
const watchlistSearchSchema = storedInstrumentSearchSchema.extend({
  fetchedAt: z.iso.datetime(),
  items: z.array(
    storedInstrumentSchema.extend({
      first_day: z.iso
        .date()
        .nullable()
        .transform((day) => day ?? ""),
      last_day: z.iso
        .date()
        .nullable()
        .transform((day) => day ?? ""),
      candle_count: z.number().int().nonnegative(),
    }),
  ),
});

/** Debounce cancellable catalog reads and clear a previous identity when search text changes. */
export function StoredInstrumentPicker({
  disabled = false,
  onSelect,
  onClear = () => {},
  watchlist = false,
}: {
  disabled?: boolean;
  onSelect: (instrument: StoredInstrument) => void;
  onClear?: () => void;
  watchlist?: boolean;
}) {
  const [segment, setSegment] = useState("cash");
  const [catalogDate, setCatalogDate] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<StoredInstrumentSearch | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const ranked = [...(result?.items ?? [])].sort((left, right) => {
    if (watchlist) {
      return 0;
    } // Preserve server-side global ranking across pages.
    const rank = (symbol: string) =>
      symbol.toUpperCase() === query.trim().toUpperCase()
        ? 0
        : symbol.toUpperCase().startsWith(query.trim().toUpperCase())
          ? 1
          : 2;
    return (
      rank(left.symbol) - rank(right.symbol) ||
      left.symbol.localeCompare(right.symbol)
    );
  });

  /** Search only after a short pause; an obsolete query is aborted before it can update results. */
  useEffect(() => {
    if (disabled || (!watchlist && query.trim().length < 2)) {
      setResult(null);
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError("");
      void requestApiJson(
        watchlist
          ? `/eod/watchlist-instruments?q=${encodeURIComponent(query.trim())}&offset=${offset}&segment=${segment}`
          : `/eod/instruments?q=${encodeURIComponent(query.trim())}&offset=${offset}`,
        "GET",
        undefined,
        undefined,
        15000,
        abort.signal,
      )
        .then(
          /** Accept only the documented stored-catalog response. */ (
            value,
          ) => {
            if (!abort.signal.aborted) {
              if (watchlist) {
                setCatalogDate(
                  new Date(
                    watchlistSearchSchema.parse(value).fetchedAt,
                  ).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
                );
              }
              setResult(
                (watchlist
                  ? watchlistSearchSchema
                  : storedInstrumentSearchSchema
                ).parse(value),
              );
            }
          },
        )
        .catch(
          /** Surface a safe read failure without retrying automatically. */ (
            failure,
          ) => {
            if (!abort.signal.aborted) {
              setError(
                failure instanceof Error
                  ? failure.message
                  : "Stored instrument search unavailable.",
              );
            }
          },
        )
        .finally(
          /** End this query's loading state only while it remains current. */ () => {
            if (!abort.signal.aborted) {
              setBusy(false);
            }
          },
        );
    }, 300);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [offset, query, watchlist, segment, disabled]);

  return (
    <div className="screen-stack stored-instrument-picker">
      {watchlist && (
        <div
          role="group"
          aria-label="Search market segment"
          className="screen-toolbar"
        >
          {[
            ["cash", "Cash"],
            ["fno", "F&O"],
            ["index", "Indices"],
          ].map(([value, label]) => (
            <Button
              key={value}
              variant={segment === value ? "primary" : "secondary"}
              aria-pressed={segment === value}
              disabled={disabled}
              onClick={() => {
                // An unchanged segment does not trigger the fetch effect: retain its results.
                if (segment === value) {
                  return;
                }
                setDismissed(false);
                setSegment(value);
                setOffset(0);
                setResult(null);
                setSelectedId("");
                setError("");
                onClear();
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      <label>
        {watchlist
          ? "Search by stock name or symbol"
          : "Search stored NSE scrips or indices"}
        <input
          ref={searchInput}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(
            result?.items.length && !busy && !selectedId && !dismissed,
          )}
          aria-controls={listId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDismissed(true);
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setDismissed(false);
              // Let React render the reopened list before moving keyboard focus.
              requestAnimationFrame(() =>
                document
                  .getElementById(listId)
                  ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
                  ?.focus(),
              );
            }
          }}
          value={query}
          maxLength={60}
          disabled={disabled}
          placeholder="Type RELIANCE, INFY or NIFTY…"
          onChange={(event) => {
            setDismissed(false);
            if (selectedId) {
              onClear();
            }
            setSelectedId("");
            setQuery(event.target.value);
            setOffset(0);
            setResult(null);
            setError("");
          }}
        />
      </label>
      {watchlist && segment === "fno" && (
        <p>
          F&O underlyings · charts show the stock/index, not individual
          contracts.
        </p>
      )}
      {watchlist && catalogDate && (
        <small>NSE catalogue updated {catalogDate}</small>
      )}
      {busy && <p role="status">Searching instruments…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {selectedId && (
        <div className="screen-toolbar">
          <p role="status">
            Selected:{" "}
            {result?.items.find((item) => item.id === selectedId)?.symbol ??
              query}
          </p>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              setDismissed(false);
              setSelectedId("");
              onClear();
              searchInput.current?.focus();
            }}
          >
            Change instrument
          </Button>
        </div>
      )}
      {result && !busy && !selectedId && !dismissed && (
        <>
          {result.items.length ? (
            <div
              className="stored-instrument-results"
              id={listId}
              role="listbox"
              aria-label={
                watchlist
                  ? "NSE instrument matches"
                  : "Stored instrument matches"
              }
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
                  return;
                }
                event.preventDefault();
                if (event.key === "Escape") {
                  setDismissed(true);
                  searchInput.current?.focus();
                  return;
                }
                const choices = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                const index = choices.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                choices[
                  (index +
                    (event.key === "ArrowDown" ? 1 : choices.length - 1)) %
                    choices.length
                ]?.focus();
              }}
            >
              {ranked.map(
                /** Bind selection to the stable stored instrument ID and advertised coverage. */ (
                  item,
                ) => (
                  <Button
                    key={item.id}
                    variant={selectedId === item.id ? "primary" : "secondary"}
                    role="option"
                    aria-selected={selectedId === item.id}
                    disabled={disabled}
                    onClick={() => {
                      setSelectedId(item.id);
                      onSelect(item);
                      searchInput.current?.focus();
                    }}
                  >
                    {watchlist ? (
                      item.name
                    ) : (
                      <>
                        {item.symbol} · {item.kind} {item.series} ·{" "}
                        {item.first_day} to {item.last_day}
                      </>
                    )}
                  </Button>
                ),
              )}
            </div>
          ) : (
            <p role="status">
              {watchlist
                ? "No stocks match this name in the selected segment."
                : "No stored history matches this search."}
            </p>
          )}
          <div className="screen-toolbar">
            <Button
              variant="secondary"
              disabled={disabled || offset === 0}
              onClick={() => {
                setResult(null);
                setOffset(Math.max(0, offset - 50));
              }}
            >
              Previous matches
            </Button>
            <Button
              variant="secondary"
              disabled={disabled || result.nextOffset === null}
              onClick={() => {
                setResult(null);
                setOffset(result.nextOffset ?? offset);
              }}
            >
              More matches
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
