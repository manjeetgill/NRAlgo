"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import type { BrokerInstrument } from "./instrument-picker";
import { Button } from "./ui/button";
import dynamic from "next/dynamic";

/** Load the canvas library only when a user opens a contract chart; never render it on the server. */
const ContractPriceChart = dynamic(
  () => import("@/features/option-chain/contract-price-chart"),
  {
    ssr: false,
    loading: () => <p role="status">Loading chart…</p>,
  },
);

export type LiveTick = {
  exchange: string;
  instrument: string;
  ltp?: number;
  receivedRecently?: boolean;
  receivedAt?: number;
  openInterest?: number;
  volume?: string;
  change?: number;
  depth?: {
    buy: { price: number; quantity?: number }[];
    sell: { price: number; quantity?: number }[];
  };
};
export type ChainContract = BrokerInstrument & {
  price: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  stale: boolean;
  tickAt?: number;
  volume?: number | null;
  change?: number | null;
};
type Contract = ChainContract;
/** A stable empty dependency prevents price renders from reloading the broker chain. */
const EMPTY_POSITION_STRIKES: { symbol: string; strike: number }[] = [];
type Chain = {
  source?: string;
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
  positionStrikes = EMPTY_POSITION_STRIKES,
  onAddLeg,
  compact = false,
}: {
  csrf: string;
  ticks: LiveTick[];
  positionStrikes?: { symbol: string; strike: number }[];
  onAddLeg?: (contract: ChainContract, side: "buy" | "sell") => string;
  compact?: boolean;
}) {
  const detailDialog = useRef<HTMLDialogElement>(null);
  const [selectedToken, setSelectedToken] = useState("");
  const [showChart, setShowChart] = useState(false);
  const [draftError, setDraftError] = useState("");
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

  /** Resolve official index membership on selection; abort the previous HTTP read on change/unmount. */
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

  /** Load broker-supported underlying facets once per session; ignore a departed screen's promise. */
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

  /** Replace expiries when the underlying changes, fencing old results before selecting the first expiry. */
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

  /** Load one strike page and subscribe its contracts; cleanup invalidates results without stopping the shared feed. */
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
                (item: BrokerInstrument) =>
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

  /** Merge valid cached ticks into the displayed chain only; this effect never calls a broker API. */
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
        {item ? (
          <button
            className="chain-price-button"
            aria-label={`Inspect ${item.symbol} ${item.option?.strikePrice} ${right}`}
            onClick={() => {
              setSelectedToken(item.instrument);
              setDraftError("");
              detailDialog.current?.showModal();
            }}
          >
            {amount(item.price)}
          </button>
        ) : (
          "—"
        )}
        {!current && (
          <small>
            {!item ? "—" : item.tickAt || item.stale ? "Stale" : "Snapshot"}
          </small>
        )}
      </td>
    );
    if (compact) {
      const depth = (
        <td>
          {amount(item?.bid)} / {amount(item?.ask)}
        </td>
      );
      return right === "call" ? (
        <>
          {oi}
          {depth}
          {mark}
        </>
      ) : (
        <>
          {mark}
          {depth}
          {oi}
        </>
      );
    }
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
  const selected = chain?.items.find(
    (item) => item.instrument === selectedToken,
  );
  const selectedTick = ticks.find(
    (tick) =>
      tick.exchange === "nse_fo" && String(tick.instrument) === selectedToken,
  );
  /** Only copy metadata into a draft; stale prices never become executable order premiums. */
  function addSelectedLeg(side: "buy" | "sell") {
    if (!selected || !onAddLeg) {
      return;
    }
    const message = onAddLeg(selected, side);
    if (message) {
      setDraftError(message);
    } else {
      detailDialog.current?.close();
    }
  }
  return (
    <section
      className={`live-option-chain${compact ? " reference-chain" : ""}`}
      aria-label="Live option chain"
    >
      <dialog
        ref={detailDialog}
        className={`workspace-dialog contract-drawer${showChart ? " contract-drawer-chart" : ""}`}
        aria-labelledby="contract-detail-title"
        onClose={() => {
          setSelectedToken("");
          setShowChart(false);
        }}
      >
        <div className="screen-toolbar">
          <h2 id="contract-detail-title">Strike detail</h2>
          <Button
            variant="secondary"
            onClick={() => detailDialog.current?.close()}
          >
            Close details
          </Button>
        </div>
        {selected ? (
          <>
            <p>
              {selected.symbol} · {selected.option?.expiryDate} ·{" "}
              {selected.option?.strikePrice} {selected.option?.right}
            </p>
            <p>
              Lot size: {selected.lotSize} units · LTP ₹{amount(selected.price)}{" "}
              ·{" "}
              {selectedTick?.receivedRecently
                ? "Recent quote"
                : "Snapshot / stale"}
            </p>
            <Button
              variant="secondary"
              onClick={() => setShowChart((value) => !value)}
            >
              {showChart ? "Hide price chart" : "Open price chart"}
            </Button>
            {showChart && (
              <ContractPriceChart
                key={selected.instrument}
                instrument={selected}
                csrf={csrf}
                tick={selectedTick}
              />
            )}
            <table>
              <thead>
                <tr>
                  <th>Bid qty</th>
                  <th>Bid</th>
                  <th>Ask</th>
                  <th>Ask qty</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(
                  {
                    length: Math.max(
                      1,
                      Math.min(
                        5,
                        Math.max(
                          selectedTick?.depth?.buy.length ?? 0,
                          selectedTick?.depth?.sell.length ?? 0,
                        ),
                      ),
                    ),
                  },
                  (_, index) => (
                    <tr key={index}>
                      <td>
                        {selectedTick?.depth?.buy[index]?.quantity ?? "—"}
                      </td>
                      <td>
                        {amount(
                          selectedTick?.depth?.buy[index]?.price ??
                            (index === 0 ? selected.bid : null),
                        )}
                      </td>
                      <td>
                        {amount(
                          selectedTick?.depth?.sell[index]?.price ??
                            (index === 0 ? selected.ask : null),
                        )}
                      </td>
                      <td>
                        {selectedTick?.depth?.sell[index]?.quantity ?? "—"}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
            <p>
              Only available broker depth is shown. Greeks and IV are
              unavailable from this feed.
            </p>
            {draftError && <p role="alert">{draftError}</p>}
            {onAddLeg && (
              <div className="screen-toolbar">
                <Button onClick={() => addSelectedLeg("buy")}>
                  Add Buy leg
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => addSelectedLeg("sell")}
                >
                  Add Sell leg
                </Button>
              </div>
            )}
            <p>Adding a leg opens research. It does not place an order.</p>
          </>
        ) : (
          <p>This contract is no longer in the current chain selection.</p>
        )}
      </dialog>
      <header>
        <div>
          <h3>Option chain</h3>
          <p>
            {chain?.source || "Market data provider"} · NSE options · read only
          </p>
        </div>
        <span className="chain-source">Shared position price feed</span>
      </header>
      <div className="chain-toolbar">
        <label>
          {compact ? "Underlying" : "Select index"}
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
                    ? "Loading provider symbols…"
                    : !eligibleStocks.length
                      ? "No constituents with listed options"
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
      {busy && <p role="status">Loading selected option chain…</p>}
      <div className="table-wrap chain-scroll">
        <table>
          <thead>
            <tr>
              <th colSpan={compact ? 3 : 6} className="chain-call-heading">
                CALLS
              </th>
              <th rowSpan={2} className="chain-strike">
                Strike
              </th>
              <th colSpan={compact ? 3 : 6} className="chain-put-heading">
                PUTS
              </th>
            </tr>
            <tr>
              {compact ? (
                <>
                  <th>OI</th>
                  <th>Bid / Ask</th>
                  <th>LTP</th>
                  <th>LTP</th>
                  <th>Bid / Ask</th>
                  <th>OI</th>
                </>
              ) : (
                <>
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
                </>
              )}
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
