"use client";

/** Read-only, explicit-expiry option-chain picker. Prices are indicative, not trade authorization.
 * It adds/replaces a research leg only; the parent must save before quoting or simulating.
 */
import { useState, type FormEvent } from "react";
import { Button } from "./ui/button";
type Contract = {
  stockCode: string;
  expiryDate: string;
  right: "call" | "put";
  strikePrice: number;
  price: number;
  bid: number;
  ask: number;
  openInterest: number;
  volume: number;
  stale: boolean;
};
type Leg = {
  stockCode: string;
  expiryDate: string;
  right: "call" | "put";
  strikePrice: number;
  side: "buy" | "sell";
  quantity: number;
};
/** Keep a bounded visible strike list; API contract identity is checked on the server. */
export function OptionChainPicker({
  csrf,
  legCount,
  disabled,
  onSelect,
}: {
  csrf: string;
  legCount: number;
  disabled: boolean;
  onSelect: (leg: Leg, index: number) => void;
}) {
  const [stockCode, setStockCode] = useState("NIFTY"),
    [expiryDate, setExpiryDate] = useState("");
  const [contracts, setContracts] = useState<Contract[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [filter, setFilter] = useState(""),
    [right, setRight] = useState("all"),
    [page, setPage] = useState(0),
    [target, setTarget] = useState(0);
  /** Fetch only when requested. Changing the query clears its old chain before another selection. */
  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setContracts([]);
    setPage(0);
    try {
      const response = await fetch("/api/research/option-chain", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ stockCode, expiryDate }),
        signal: AbortSignal.timeout(95000),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.detail || "Option chain unavailable.");
      setContracts(result.contracts);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = contracts.filter(
    (item) =>
      (right === "all" || item.right === right) &&
      String(item.strikePrice).includes(filter),
  );
  const index = Math.min(target, legCount),
    canAdd = index < legCount || legCount < 4;
  /** A selected premium is not carried into an order. Quantity starts at one unvalidated unit. */
  function choose(contract: Contract, side: "buy" | "sell") {
    onSelect(
      {
        stockCode: contract.stockCode,
        expiryDate: contract.expiryDate,
        right: contract.right,
        strikePrice: contract.strikePrice,
        side,
        quantity: 1,
      },
      index,
    );
  }
  return (
    <section className="research-chain" aria-label="Option chain picker">
      <h3>Pick a contract from ICICI</h3>
      <p className="research-note">
        Enter an underlying and expiry, then replace a leg or add one. Returned
        strikes may be a subset; this is not a historical chain or an
        expiry-calendar service.
      </p>
      <form onSubmit={load}>
        <fieldset disabled={busy || disabled}>
          <div className="research-fields">
            <label>
              Chain underlying
              <input
                required
                maxLength={30}
                value={stockCode}
                onChange={(event) => {
                  setStockCode(event.target.value.toUpperCase());
                  setContracts([]);
                }}
              />
            </label>
            <label>
              Chain expiry
              <input
                type="date"
                required
                value={expiryDate}
                onChange={(event) => {
                  setExpiryDate(event.target.value);
                  setContracts([]);
                }}
              />
            </label>
          </div>
          <Button type="submit">
            {busy ? "Loading chain…" : "Load option chain"}
          </Button>
        </fieldset>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {contracts.length > 0 && (
        <>
          <div className="research-fields">
            <label>
              Filter strike
              <input
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              Filter option type
              <select
                value={right}
                onChange={(event) => {
                  setRight(event.target.value);
                  setPage(0);
                }}
              >
                <option value="all">Calls and puts</option>
                <option value="call">Calls</option>
                <option value="put">Puts</option>
              </select>
            </label>
            <label>
              Apply selected contract to
              <select
                value={index}
                onChange={(event) => setTarget(Number(event.target.value))}
              >
                {Array.from({ length: legCount }, (_, i) => (
                  <option key={i} value={i}>
                    Replace leg {i + 1}
                  </option>
                ))}
                <option value={legCount} disabled={legCount >= 4}>
                  Add new leg
                </option>
              </select>
            </label>
          </div>
          <p className="research-note">
            {contracts.length} returned contracts · indicative snapshot · verify
            lot size after selection. Fresh order quotes are always fetched
            separately.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Strike</th>
                  <th>Type</th>
                  <th>Last ₹</th>
                  <th>Bid / ask ₹</th>
                  <th>OI</th>
                  <th>Data</th>
                  <th>Research leg</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(page * 20, page * 20 + 20).map((contract) => (
                  <tr key={`${contract.right}:${contract.strikePrice}`}>
                    <td>{contract.strikePrice}</td>
                    <td>{contract.right}</td>
                    <td>{contract.price.toFixed(2)}</td>
                    <td>
                      {contract.bid.toFixed(2)} / {contract.ask.toFixed(2)}
                    </td>
                    <td>{contract.openInterest}</td>
                    <td>
                      {contract.stale ? "Stale / unavailable" : "Snapshot"}
                    </td>
                    <td>
                      <div className="live-actions">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled || !canAdd}
                          onClick={() => choose(contract, "buy")}
                          aria-label={`Use ${contract.strikePrice} ${contract.right} buy`}
                        >
                          Buy leg
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled || !canAdd}
                          onClick={() => choose(contract, "sell")}
                          aria-label={`Use ${contract.strikePrice} ${contract.right} sell`}
                        >
                          Sell leg
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="live-actions">
            <Button
              variant="secondary"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous strikes
            </Button>
            <span>
              {filtered.length} matching contracts · page {page + 1}
            </span>
            <Button
              variant="secondary"
              disabled={(page + 1) * 20 >= filtered.length}
              onClick={() => setPage(page + 1)}
            >
              Next strikes
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
