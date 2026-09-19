"use client";
/** Kotak live snapshots. All requests are manual and paginated;
 * selecting metadata only prefills a paper ticket, never places an order or trusts its premium.
 */
import { useEffect, useRef, useState } from "react";
import { useMarketFeed } from "@/features/option-chain/use-market-feed";
import { requestApiJson } from "@/lib/api";
import { Button } from "./ui/button";
import type { BrokerInstrument } from "./instrument-picker";
type ChainRow = BrokerInstrument & {
  price: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  stale: boolean;
  tickAt?: number;
};
type Chain = {
  items: ChainRow[];
  expiries: string[];
  total: number;
  nextOffset: number | null;
  warning?: string;
};
/** A generation fence discards in-flight results after changing the underlying or expiry. */
export function KotakOptionChain({
  csrf,
  disabled = false,
  onSelect,
  selectionLabel = "Use paper contract",
}: {
  csrf: string;
  disabled?: boolean;
  onSelect?: (item: BrokerInstrument) => void;
  selectionLabel?: string;
}) {
  const [underlying, setUnderlying] = useState("NIFTY"),
    [expiry, setExpiry] = useState("");
  const [chain, setChain] = useState<Chain | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [offset, setOffset] = useState(0);
  const generation = useRef(0);
  const feed = useMarketFeed(csrf, Boolean(chain?.items.length));
  // The broker can supply stream prices even when the initial REST batch is unavailable.
  // Keep the last observed price visible and label it stale when ticks stop arriving.
  useEffect(() => {
    setChain((previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((item) => {
              const tick = feed.ticks.find(
                (value) =>
                  value.exchange === "nse_fo" &&
                  String(value.instrument) === item.instrument,
              );
              if (
                tick?.receivedRecently &&
                typeof tick.ltp === "number" &&
                Number.isFinite(tick.ltp) &&
                tick.ltp > 0
              ) {
                return {
                  ...item,
                  price: tick.ltp,
                  bid: tick.depth?.buy?.[0]?.price ?? item.bid,
                  ask: tick.depth?.sell?.[0]?.price ?? item.ask,
                  openInterest: tick.openInterest ?? item.openInterest,
                  tickAt: tick.receivedAt,
                  stale: false,
                };
              }
              return item.tickAt && Date.now() - item.tickAt > 15000
                ? { ...item, stale: true }
                : item;
            }),
          }
        : previous,
    );
  }, [feed.ticks]);
  /** Fetch the selected bounded option-chain page; never substitute fabricated prices on failure. */
  async function load(nextOffset: number, metadata = false) {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setChain(null);
    try {
      // Seek the middle of the selected expiry before fetching a bounded quote batch.
      // The lowest listed strikes frequently have no quotes.
      if (!metadata && nextOffset === -1) {
        const contracts = await requestApiJson(
          "/market/instruments",
          "POST",
          {
            market: "options",
            query: underlying,
            underlying,
            expiryDate: expiry,
            offset: 0,
          },
          csrf,
          95000,
        );
        if (current !== generation.current) {
          return;
        }
        nextOffset = Math.max(0, Math.floor(contracts.total / 2) - 24);
      }
      const result = await requestApiJson(
        "/paper/kotak/option-chain",
        "POST",
        {
          underlying,
          ...(expiry && !metadata ? { expiryDate: expiry } : {}),
          offset: nextOffset,
        },
        csrf,
        95000,
      );
      if (current !== generation.current) {
        return;
      }
      setChain(result);
      setOffset(nextOffset);
      if (metadata) {
        setExpiry(result.expiries[0] || "");
      } else if (result.items.length) {
        await requestApiJson(
          "/market/live-feed",
          "POST",
          {
            instruments: result.items.map((item: ChainRow) => item.instrument),
          },
          csrf,
          95000,
        );
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
  }
  const money = (value: number | null) =>
    value === null ? "Unavailable" : value.toFixed(2);
  return (
    <section className="kotak-data-panel" aria-label="Kotak option chain">
      <h3>Kotak live option chain</h3>
      <p>
        Broker snapshots and shared price feed · up to 50 contracts per page.
        Closed-market or old quotes are marked stale.
      </p>
      <fieldset disabled={disabled || busy}>
        <label>
          Underlying
          <input
            value={underlying}
            maxLength={40}
            onChange={(event) => {
              generation.current++;
              setUnderlying(event.target.value.toUpperCase());
              setExpiry("");
              setChain(null);
            }}
          />
        </label>
        <Button type="button" onClick={() => void load(0, true)}>
          Load Kotak expiries
        </Button>
        <label>
          Expiry
          <select
            aria-label="Kotak chain expiry"
            value={expiry}
            onChange={(event) => {
              generation.current++;
              setExpiry(event.target.value);
              setChain((value) => (value ? { ...value, items: [] } : null));
            }}
          >
            <option value="">Choose expiry</option>
            {chain?.expiries.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" disabled={!expiry} onClick={() => void load(-1)}>
          Load / refresh Kotak chain
        </Button>
      </fieldset>
      {busy && <p role="status">Loading Kotak market data…</p>}
      {error && <p role="alert">{error}</p>}
      {chain?.warning && chain.items.some((item) => item.price === null) && (
        <p role="status">{chain.warning}</p>
      )}
      {chain?.items.length && feed.error ? (
        <p role="alert">{feed.error}</p>
      ) : null}
      {chain && !busy && (
        <>
          {!chain.expiries.length && (
            <p>No current contracts found for this exact underlying.</p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Strike</th>
                  <th>Type</th>
                  <th>Last ₹</th>
                  <th>Bid / ask ₹</th>
                  <th>OI</th>
                  <th>Lot</th>
                  <th>Data</th>
                  {onSelect && <th>Paper ticket</th>}
                </tr>
              </thead>
              <tbody>
                {chain.items.map((item) => (
                  <tr key={item.masterToken}>
                    <td>{item.option?.strikePrice}</td>
                    <td>{item.option?.right}</td>
                    <td>{money(item.price)}</td>
                    <td>
                      {money(item.bid)} / {money(item.ask)}
                    </td>
                    <td>{item.openInterest ?? "Unavailable"}</td>
                    <td>{item.lotSize}</td>
                    <td>
                      {item.stale ? "Stale / unavailable" : "Price snapshot"}
                    </td>
                    {onSelect && (
                      <td>
                        <Button
                          type="button"
                          disabled={disabled}
                          onClick={() => onSelect(item)}
                        >
                          {selectionLabel}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {chain.items.length > 0 && (
            <>
              <p>
                {chain.total} contracts · page {Math.floor(offset / 50) + 1}
              </p>
              <Button
                type="button"
                disabled={disabled || busy || offset === 0}
                onClick={() => void load(Math.max(0, offset - 50))}
              >
                Previous
              </Button>
              <Button
                type="button"
                disabled={disabled || busy || chain.nextOffset === null}
                onClick={() => void load(chain.nextOffset!)}
              >
                Next
              </Button>
            </>
          )}
        </>
      )}
    </section>
  );
}
