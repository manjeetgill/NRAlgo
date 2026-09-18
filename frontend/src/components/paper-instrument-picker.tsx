"use client";
/** Current-master search only. Selecting a row fills a paper ticket; it never submits an order.
 * Every request is manual, owner-authenticated and CSRF protected; no broker secrets enter React.
 */
import { useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
export interface PaperInstrument {
  masterToken: string;
  instrument: string;
  symbol: string;
  name: string;
  market: "cash" | "options";
  lotSize: number;
  option?: {
    expiryDate: string;
    right: "call" | "put";
    strikePrice: number;
    lotSize: number;
  };
}
type SearchResult = {
  items: PaperInstrument[];
  total: number;
  expiries: string[];
  underlyings: string[];
  fetchedAt: number;
  nextOffset: number | null;
};
export function PaperInstrumentPicker({
  broker,
  market,
  csrf,
  disabled,
  onSelect,
}: {
  broker: "icici" | "kotak";
  market: "cash" | "options";
  csrf: string;
  disabled: boolean;
  onSelect: (instrument: PaperInstrument) => void;
}) {
  const [query, setQuery] = useState(market === "options" ? "NIFTY" : ""),
    [expiry, setExpiry] = useState(""),
    [right, setRight] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0);
  const [underlying, setUnderlying] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  /** Only the current request may update this broker/market's search results. */
  async function search(nextOffset = 0) {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const data = await requestApiJson(`/paper/${broker}/instruments`, "POST", {
        market, query, offset: nextOffset,
        ...(expiry ? { expiryDate: expiry } : {}),
        ...(underlying ? { underlying } : {}),
        ...(right ? { right } : {}),
      }, csrf, 60000);
      if (current === generation.current) {
        setResult(data);
        setOffset(nextOffset);
      }
    } catch (error) {
      if (current === generation.current) {
        setResult(null);
        setError(
          error instanceof Error ? error.message : "Instrument search failed.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Paper instrument picker">
      <h4>
        {market === "options"
          ? "Option contract chain"
          : "Cash instrument search"}
      </h4>
      <p>
        Search broker master data, then select the exact contract. No quotes are
        fetched for the whole chain. Use Refresh paper quotes after selection to
        check the chosen instrument. Only NSE EQ cash and calls/puts with lot
        sizes up to 10,000 units are supported.
      </p>
      <div className="paper-grid">
        <label>
          Instrument search
          <input
            value={query}
            minLength={2}
            maxLength={40}
            disabled={busy || disabled}
            placeholder="NIFTY, RELIANCE…"
            onChange={(event) => {
              setQuery(event.target.value.toUpperCase());
              setResult(null);
              setExpiry("");
              setUnderlying("");
            }}
          />
        </label>
        {market === "options" && (
          <>
            <label>
              Picker underlying
              <select
                disabled={busy || disabled}
                value={underlying}
                onChange={(event) => {
                  setUnderlying(event.target.value);
                  setExpiry("");
                }}
              >
                <option value="">All matching underlyings</option>
                {result?.underlyings.map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Picker expiry
              <select
                disabled={busy || disabled}
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              >
                <option value="">All listed expiries</option>
                {result?.expiries.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Picker option type
              <select
                disabled={busy || disabled}
                value={right}
                onChange={(event) => setRight(event.target.value)}
              >
                <option value="">Calls and puts</option>
                <option value="call">Calls</option>
                <option value="put">Puts</option>
              </select>
            </label>
          </>
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        disabled={busy || disabled || query.trim().length < 2}
        onClick={() => void search()}
      >
        {busy ? "Loading instrument master…" : "Search broker instruments"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>
            {result.total} matching instruments · Master fetched{" "}
            {new Date(result.fetchedAt).toLocaleString("en-IN")}. Current
            metadata only, not historical lot sizes or proof of trading
            permission. Filters apply when you search.
          </p>
          <div className="paper-table">
            <table>
              <thead>
                <tr>
                  <th>Symbol / token</th>
                  <th>Expiry</th>
                  <th>Strike</th>
                  <th>Type</th>
                  <th>Lot units</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.masterToken}>
                    <td>
                      {item.symbol} · {item.instrument}
                      <br />
                      {item.name}
                    </td>
                    <td>{item.option?.expiryDate || "—"}</td>
                    <td>{item.option?.strikePrice ?? "—"}</td>
                    <td>{item.option?.right || "Cash"}</td>
                    <td>{item.lotSize}</td>
                    <td>
                      <Button
                        type="button"
                        disabled={busy || disabled}
                        aria-label={`Select ${item.symbol} ${item.option ? `${item.option.expiryDate} ${item.option.strikePrice} ${item.option.right}` : "cash"}`}
                        onClick={() => onSelect(item)}
                      >
                        Select contract
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.items.length && (
            <p>
              No matching supported instruments. Refine the symbol or expiry;
              missing contracts are not fabricated.
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={busy || disabled || offset === 0}
            onClick={() => void search(Math.max(0, offset - 50))}
          >
            Previous instruments
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || disabled || result.nextOffset === null}
            onClick={() => void search(result.nextOffset!)}
          >
            Next instruments
          </Button>
        </>
      )}
    </section>
  );
}
