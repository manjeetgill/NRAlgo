"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import type { PaperInstrument } from "./paper-instrument-picker";
import { Button } from "./ui/button";

export type LiveTick = {
  exchange: string;
  instrument: string;
  ltp?: number;
  receivedRecently?: boolean;
  receivedAt?: number;
  openInterest?: number;
  volume?: string;
  change?: number;
  depth?: { buy: { price: number }[]; sell: { price: number }[] };
};
type Contract = PaperInstrument & {
  price: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  stale: boolean;
  tickAt?: number;
  volume?: number | null;
  change?: number | null;
};
type Chain = {
  warning?: string;
  items: Contract[];
  expiries: string[];
  total: number;
  nextOffset: number | null;
};
const amount = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "—";

/** One master/quote snapshot per selection. Subsequent marks share the overview's tick batch. */
export function LiveOptionChain({
  csrf,
  ticks,
  positionStrikes = [],
}: {
  csrf: string;
  ticks: LiveTick[];
  positionStrikes?: { symbol: string; strike: number }[];
}) {
  const [index, setIndex] = useState("NIFTY");
  const [members, setMembers] = useState<{
    index: string;
    symbols: string[];
  } | null>(null);
  const [memberError, setMemberError] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [underlying, setUnderlying] = useState("NIFTY");
  const [expiry, setExpiry] = useState("");
  const [expiries, setExpiries] = useState<string[]>([]);
  const [chain, setChain] = useState<Chain | null>(null);
  const [offset, setOffset] = useState(-1);
  const [displayedOffset, setDisplayedOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searchError, setSearchError] = useState("");
  const [feedError, setFeedError] = useState("");
  const generation = useRef(0);
  // React strict-mode remounts and fast selections must not overlap broker operations.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const read = useCallback(
    (path: string, body: unknown) => {
      const next = queue.current
        .catch(() => {})
        .then(() => requestApiJson(path, "POST", body, csrf, 95000));
      queue.current = next;
      return next;
    },
    [csrf],
  );

  useEffect(() => {
    const controller = new AbortController();
    setMembers(null);
    setMemberError("");
    void (async () => {
      try {
        const response = await fetch(
          `/reference/index-constituents?index=${encodeURIComponent(index)}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "Index constituents unavailable");
        }
        if (
          result.index !== index ||
          !Array.isArray(result.symbols) ||
          !result.symbols.every((symbol: unknown) => typeof symbol === "string")
        ) {
          throw new Error("Invalid index constituents");
        }
        if (!controller.signal.aborted) {
          setMembers(result);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setMemberError((failure as Error).message);
        }
      }
    })();
    return () => controller.abort();
  }, [index]);

  const eligibleStocks =
    members?.index === index
      ? members.symbols.filter((symbol) => symbols.includes(symbol))
      : [];

  useEffect(() => {
    let cancelled = false;
    setSearchError("");
    void (async () => {
      try {
        // Every NSE call trading symbol ends in CE. Facets cover the matching
        // master, not just the 50 returned contracts, so this prefills symbols.
        const result = await read("/market/instruments", {
          market: "options",
          query: "CE",
          offset: 0,
        });
        if (!cancelled) {
          setSymbols(result.underlyings);
        }
      } catch (failure) {
        if (!cancelled) {
          setSearchError((failure as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [read]);

  useEffect(() => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setChain(null);
    setExpiries([]);
    setExpiry("");
    setOffset(-1);
    void read("/market/option-chain", { underlying, offset: 0 })
      .then((result) => {
        if (current !== generation.current) {
          return;
        }
        setExpiries(result.expiries);
        setExpiry(result.expiries[0] || "");
        if (!result.expiries.length) {
          setError("No current expiries found for this underlying.");
        }
      })
      .catch((failure) => {
        if (current === generation.current) {
          setError(failure.message);
        }
      })
      .finally(() => {
        if (current === generation.current) {
          setBusy(false);
        }
      });
    return () => {
      generation.current = current + 1;
    };
  }, [underlying, read]);

  useEffect(() => {
    if (!expiry) {
      return;
    }
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setFeedError("");
    setChain(null);
    void (async () => {
      try {
        let start = offset;
        if (start < 0) {
          // The master resolves exact identities even when native chain quotes are unavailable.
          // Seek around an open position (or the middle of the listed strikes), never the first deep-ITM page.
          const search = (start: number) =>
            read("/market/instruments", {
              market: "options",
              query: underlying,
              underlying,
              expiryDate: expiry,
              offset: start,
            });
          const first = await search(0);
          const target = positionStrikes.find(
            (p) =>
              p.symbol.startsWith(underlying) &&
              /^\d/.test(p.symbol.slice(underlying.length)) &&
              p.strike > 0,
          )?.strike;
          start = Math.max(0, Math.floor(first.total / 2) - 24);
          if (target && first.total) {
            let low = 0,
              high = Math.ceil(first.total / 50) - 1;
            while (low <= high) {
              const page = Math.floor((low + high) / 2);
              const rows = page === 0 ? first : await search(page * 50);
              const index = rows.items.findIndex(
                (item: PaperInstrument) =>
                  (item.option?.strikePrice ?? 0) >= target,
              );
              if (index === -1) {
                low = page + 1;
              } else {
                start = Math.max(0, page * 50 + index - 24);
                high = page - 1;
              }
            }
          }
          start -= start % 2;
        }
        const result: Chain = await read("/market/option-chain", {
          underlying,
          expiryDate: expiry,
          offset: start,
        });
        if (current !== generation.current) {
          return;
        }
        setDisplayedOffset(start);
        setChain(result);
        if (result.items.length) {
          try {
            await read("/market/live-feed", {
              instruments: result.items.map((item) => item.instrument),
            });
          } catch (failure) {
            if (current === generation.current) {
              setFeedError((failure as Error).message);
            }
          }
        }
      } catch (failure) {
        if (current === generation.current) {
          setError((failure as Error).message);
        }
      } finally {
        if (current === generation.current) {
          setBusy(false);
        }
      }
    })();
    return () => {
      generation.current = current + 1;
    };
  }, [underlying, expiry, offset, positionStrikes, read]);

  useEffect(() => {
    setChain((previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((item) => {
              const tick = ticks.find(
                (t) =>
                  t.exchange === "nse_fo" &&
                  String(t.instrument) === item.instrument,
              );
              return tick?.receivedRecently &&
                typeof tick.ltp === "number" &&
                tick.ltp > 0 &&
                Number.isFinite(tick.ltp)
                ? {
                    ...item,
                    price: tick.ltp,
                    volume:
                      tick.volume !== null &&
                      tick.volume !== undefined &&
                      Number.isSafeInteger(Number(tick.volume))
                        ? Number(tick.volume)
                        : item.volume,
                    change:
                      typeof tick.change === "number"
                        ? tick.change
                        : item.change,
                    bid:
                      typeof tick.depth?.buy?.[0]?.price === "number"
                        ? tick.depth.buy[0].price
                        : item.bid,
                    ask:
                      typeof tick.depth?.sell?.[0]?.price === "number"
                        ? tick.depth.sell[0].price
                        : item.ask,
                    openInterest:
                      typeof tick.openInterest === "number"
                        ? tick.openInterest
                        : item.openInterest,
                    tickAt: tick.receivedAt,
                    stale: false,
                  }
                : item;
            }),
          }
        : previous,
    );
  }, [ticks]);

  const pairs = new Map<number, { call?: Contract; put?: Contract }>();
  for (const item of chain?.items ?? []) {
    if (!item.option) {
      continue;
    }
    const pair = pairs.get(item.option.strikePrice) ?? {};
    pair[item.option.right] = item;
    pairs.set(item.option.strikePrice, pair);
  }
  const maxOi = Math.max(
    1,
    ...(chain?.items ?? []).map((item) => item.openInterest ?? 0),
  );
  const side = (item: Contract | undefined, right: "call" | "put") => {
    const current =
      item &&
      ticks.some(
        (t) =>
          t.exchange === "nse_fo" &&
          String(t.instrument) === item.instrument &&
          t.receivedRecently &&
          typeof t.ltp === "number" &&
          t.ltp > 0,
      );
    const oi = (
      <td className={`chain-oi ${right}`}>
        <span
          style={{ width: `${(100 * (item?.openInterest ?? 0)) / maxOi}%` }}
        />
        <b>{item?.openInterest?.toLocaleString("en-IN") ?? "—"}</b>
      </td>
    );
    const mark = (
      <td
        className={`chain-ltp ${current ? "has-tick" : ""}`}
        title={item?.symbol}
      >
        {amount(item?.price)}
        {!current && (
          <small>
            {!item ? "—" : item.tickAt || item.stale ? "Stale" : "Snapshot"}
          </small>
        )}
      </td>
    );
    return right === "call" ? (
      <>
        {oi}
        <td>{item?.volume?.toLocaleString("en-IN") ?? "—"}</td>
        <td className={(item?.change ?? 0) < 0 ? "negative" : "positive"}>
          {amount(item?.change)}
        </td>
        <td>{amount(item?.bid)}</td>
        <td>{amount(item?.ask)}</td>
        {mark}
      </>
    ) : (
      <>
        {mark}
        <td>{amount(item?.bid)}</td>
        <td>{amount(item?.ask)}</td>
        <td className={(item?.change ?? 0) < 0 ? "negative" : "positive"}>
          {amount(item?.change)}
        </td>
        <td>{item?.volume?.toLocaleString("en-IN") ?? "—"}</td>
        {oi}
      </>
    );
  };
  return (
    <section className="live-option-chain" aria-label="Live option chain">
      <header>
        <div>
          <h3>Option chain</h3>
          <p>Kotak NSE options · read only</p>
        </div>
        <span className="chain-source">Shared position price feed</span>
      </header>
      <div className="chain-toolbar">
        <label>
          Select index
          <select
            aria-label="Option chain index"
            value={index}
            onChange={(e) => {
              setExpiry("");
              setMembers(null);
              setMemberError("");
              setIndex(e.target.value);
              setUnderlying(e.target.value);
            }}
          >
            {[
              "NIFTY",
              "NIFTYNXT50",
              "FINNIFTY",
              "BANKNIFTY",
              "MIDCPNIFTY",
              "NIFTYFPI",
            ].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Constituent stock
          <select
            aria-label="Option chain underlying"
            value={underlying === index ? "" : underlying}
            disabled={!eligibleStocks.length}
            onChange={(e) => {
              setExpiry("");
              setUnderlying(e.target.value || index);
            }}
          >
            <option value="">
              {memberError
                ? "Constituents unavailable"
                : !members
                  ? "Loading constituents…"
                  : !symbols.length
                    ? "Loading Kotak symbols…"
                    : !eligibleStocks.length
                      ? "No constituents with Kotak options"
                      : `Select stock — ${index} chain`}
            </option>
            {eligibleStocks.map((symbol) => (
              <option key={symbol}>{symbol}</option>
            ))}
          </select>
        </label>
        <label>
          Expiry
          <select
            aria-label="Live option chain expiry"
            value={expiry}
            disabled={!expiries.length}
            onChange={(e) => {
              setExpiry(e.target.value);
              setOffset(-1);
            }}
          >
            {!expiries.length && <option value="">Loading expiries…</option>}
            {expiries.map((day) => (
              <option key={day}>{day}</option>
            ))}
          </select>
        </label>
      </div>
      {memberError && <p role="alert">{memberError}</p>}
      {searchError && <p role="alert">Search: {searchError}</p>}
      {error && <p role="alert">{error}</p>}
      {feedError && <p role="alert">Feed: {feedError}</p>}
      {chain?.warning && !chain.items.some((item) => item.tickAt) && (
        <p role="status">{chain.warning}</p>
      )}
      {busy && <p role="status">Loading selected Kotak chain…</p>}
      <div className="table-wrap chain-scroll">
        <table>
          <thead>
            <tr>
              <th colSpan={6} className="chain-call-heading">
                CALLS
              </th>
              <th rowSpan={2} className="chain-strike">
                Strike
              </th>
              <th colSpan={6} className="chain-put-heading">
                PUTS
              </th>
            </tr>
            <tr>
              <th>OI</th>
              <th>Volume</th>
              <th>Change ₹</th>
              <th>Bid ₹</th>
              <th>Ask ₹</th>
              <th>LTP ₹</th>
              <th>LTP ₹</th>
              <th>Bid ₹</th>
              <th>Ask ₹</th>
              <th>Change ₹</th>
              <th>Volume</th>
              <th>OI</th>
            </tr>
          </thead>
          <tbody>
            {[...pairs]
              .sort(([a], [b]) => a - b)
              .map(([strike, pair]) => (
                <tr key={strike}>
                  {side(pair.call, "call")}
                  <th className="chain-strike">
                    {strike.toLocaleString("en-IN")}
                  </th>
                  {side(pair.put, "put")}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {chain && !chain.items.length && <p>No contracts for this selection.</p>}
      <footer>
        <Button
          variant="secondary"
          disabled={busy || !displayedOffset}
          onClick={() => setOffset(Math.max(0, displayedOffset - 50))}
        >
          Previous strikes
        </Button>
        <span>
          {chain
            ? `Contracts ${displayedOffset + 1}–${displayedOffset + chain.items.length} of ${chain.total}`
            : ""}
        </span>
        <Button
          variant="secondary"
          disabled={
            busy ||
            chain?.nextOffset === null ||
            chain?.nextOffset === undefined
          }
          onClick={() => setOffset(chain!.nextOffset!)}
        >
          Next strikes
        </Button>
      </footer>
      <p className="chain-note">
        Prices and OI update from the same tick batch as dashboard P&amp;L. This
        page streams up to 50 chain contracts alongside up to 50 open positions.
        Snapshot or stale prices are labelled. No repeated position/report API
        calls.
      </p>
    </section>
  );
}
