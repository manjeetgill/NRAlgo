"use client";
/** Search and select exact instruments that have stored daily candles; no broker is required. */
import { useEffect, useId, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  storedInstrumentSearchSchema,
  type StoredInstrument,
  type StoredInstrumentSearch,
} from "@/lib/stored-market-data";
export type { StoredInstrument } from "@/lib/stored-market-data";

/** Debounce cancellable catalog reads and clear a previous identity when search text changes. */
export function StoredInstrumentPicker({
  disabled = false,
  onSelect,
  onClear = () => {},
}: {
  disabled?: boolean;
  onSelect: (instrument: StoredInstrument) => void;
  onClear?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<StoredInstrumentSearch | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const ranked = [...(result?.items ?? [])].sort((left, right) => {
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
    if (query.trim().length < 2) {
      setResult(null);
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError("");
      void requestApiJson(
        `/eod/instruments?q=${encodeURIComponent(query.trim())}&offset=${offset}`,
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
              setResult(storedInstrumentSearchSchema.parse(value));
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
  }, [offset, query]);

  return (
    <div className="screen-stack stored-instrument-picker">
      <label>
        Search stored NSE scrips or indices
        <input
          ref={searchInput}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(result?.items.length && !busy && !selectedId)}
          aria-controls={listId}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              document
                .getElementById(listId)
                ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
                ?.focus();
            }
          }}
          value={query}
          maxLength={60}
          disabled={disabled}
          placeholder="Type RELIANCE, INFY or NIFTY…"
          onChange={(event) => {
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
      {busy && <p role="status">Searching stored instruments…</p>}
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
              setSelectedId("");
              onClear();
              searchInput.current?.focus();
            }}
          >
            Change instrument
          </Button>
        </div>
      )}
      {result && !busy && !selectedId && (
        <>
          {result.items.length ? (
            <div
              className="stored-instrument-results"
              id={listId}
              role="listbox"
              aria-label="Stored instrument matches"
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
                  return;
                }
                event.preventDefault();
                if (event.key === "Escape") {
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
                    {item.symbol} · {item.kind} {item.series} · {item.first_day}{" "}
                    to {item.last_day}
                  </Button>
                ),
              )}
            </div>
          ) : (
            <p role="status">No stored history matches this search.</p>
          )}
          <div className="screen-toolbar">
            <Button
              variant="secondary"
              disabled={disabled || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous matches
            </Button>
            <Button
              variant="secondary"
              disabled={disabled || result.nextOffset === null}
              onClick={() => setOffset(result.nextOffset ?? offset)}
            >
              More matches
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
