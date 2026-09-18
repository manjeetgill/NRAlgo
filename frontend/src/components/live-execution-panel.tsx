"use client";
/** Explicit real-money ticket, separate from simulated ledgers. Never submits on mount or retry. */
import { useEffect, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { PaperInstrument } from "./paper-instrument-picker";

type Intent = {
  instrument: string;
  side: "buy" | "sell";
  quantity: number;
  limitPaise: number;
  reduceOnly: boolean;
};
type Preview = {
  previewId: string;
  expires: number;
  intent: Intent;
  tradingSymbol: string;
  notionalPaise: number;
};
type LiveStatus = {
  enabled: boolean;
  armed: boolean;
  halted: boolean;
  reason?: string;
  orders?: {
    id: string;
    state: string;
    intent: Intent;
    brokerOrder?: { brokerOrderId: string; filledQuantity: number } | null;
  }[];
};
const money = (paise: number) =>
  (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR" });

export function LiveExecutionPanel({ csrf }: { csrf: string }) {
  const [status, setStatus] = useState<LiveStatus | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [configured, setConfigured] = useState(false);
  const [limits, setLimits] = useState({
    reserved: "",
    exposure: "",
    units: "",
    loss: "",
    rate: "",
  });
  const [token, setToken] = useState(""),
    [armProof, setArmProof] = useState("");
  const [market, setMarket] = useState<"cash" | "options">("cash"),
    [query, setQuery] = useState("");
  const [items, setItems] = useState<PaperInstrument[]>([]),
    [selected, setSelected] = useState<PaperInstrument | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy"),
    [quantity, setQuantity] = useState(""),
    [price, setPrice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [proof, setProof] = useState("");
  const [uncertain, setUncertain] = useState(false);
  async function refresh() {
    const result = await requestApiJson("/live/status");
    setStatus(result);
    setConfigured(Boolean(result.accountId));
    return result;
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [csrf]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const post = (path: string, body: unknown = {}) =>
    requestApiJson(`/live/${path}`, "POST", body, csrf, 30000);
  function invalidate() {
    setPreview(null);
    setProof("");
  }
  return (
    <section
      className="research-panel live-execution-panel"
      aria-label="Live execution controls"
    >
      <div className="panel-heading">
        <div>
          <h2>Kotak live execution</h2>
          <p>Real money · LIMIT / DAY · NSE cash and long options</p>
        </div>
      </div>
      <p role="status">
        {status?.armed
          ? "Armed for live orders"
          : "Live submission is not armed"}
        . {status?.reason}
      </p>
      <p>
        Use a dedicated, initially flat trading account with an empty order
        book. Manual orders, carried positions or unknown outcomes halt
        execution. Paper orders are never promoted to live.
      </p>
      <p>
        Funds use Kotak RMS buying power, not a settled cash ledger. Halting
        requests cancellation of app-managed orders; it does not close
        positions.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void action(async () => {
            await refresh();
          })
        }
      >
        Check live status
      </Button>
      {status?.enabled === false ? (
        <p>
          Disabled by the server operator. Static-IP registration and explicit
          server configuration are required before activation.
        </p>
      ) : (
        <>
          {!configured && (
            <fieldset disabled={busy}>
              <legend>1. Configure risk limits (required)</legend>
              <div className="form-grid">
                {(
                  [
                    ["reserved", "Maximum reserved capital ₹"],
                    ["exposure", "Maximum gross exposure ₹"],
                    ["units", "Maximum position units"],
                    ["loss", "Maximum daily loss ₹"],
                    ["rate", "Orders per minute (1–60)"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="1"
                      value={limits[key]}
                      onChange={(e) =>
                        setLimits({ ...limits, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
              <Button
                disabled={Object.values(limits).some(
                  (v) => !v || Number(v) <= 0,
                )}
                onClick={() =>
                  void action(async () => {
                    await post("configure", {
                      maxReservedPaise: Math.round(
                        Number(limits.reserved) * 100,
                      ),
                      maxGrossExposurePaise: Math.round(
                        Number(limits.exposure) * 100,
                      ),
                      maxPositionUnits: Number(limits.units),
                      maxDailyLossPaise: Math.round(Number(limits.loss) * 100),
                      maxOrdersPerMinute: Number(limits.rate),
                      fundsDriftTolerancePaise: 0,
                    });
                    await refresh();
                  })
                }
              >
                Save live risk limits
              </Button>
            </fieldset>
          )}
          {configured && (
            <>
              <fieldset disabled={busy}>
                <legend>2. Reconcile and arm for five minutes</legend>
                <label>
                  Fresh app authenticator code
                  <input
                    type="password"
                    autoComplete="one-time-code"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <label>
                  Type ENABLE REAL MONEY
                  <input
                    value={armProof}
                    onChange={(e) => setArmProof(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <Button
                  disabled={armProof !== "ENABLE REAL MONEY" || !token}
                  onClick={() =>
                    void action(async () => {
                      try {
                        await post("arm", { token, confirmation: armProof });
                        await refresh();
                      } finally {
                        setToken("");
                        setArmProof("");
                      }
                    })
                  }
                >
                  Arm live trading
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void action(async () => {
                      await post("reconcile");
                      await refresh();
                    })
                  }
                >
                  Reconcile broker books
                </Button>
              </fieldset>
              <fieldset disabled={busy || !status?.armed || uncertain}>
                <legend>3. Review a live order</legend>
                <div className="form-grid">
                  <label>
                    Market
                    <select
                      value={market}
                      onChange={(e) => {
                        setMarket(e.target.value as "cash" | "options");
                        setItems([]);
                        setSelected(null);
                        invalidate();
                      }}
                    >
                      <option value="cash">NSE cash (CNC)</option>
                      <option value="options">NSE options (NRML)</option>
                    </select>
                  </label>
                  <label>
                    Search Kotak contract
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value.toUpperCase())}
                      placeholder="RELIANCE / NIFTY"
                    />
                  </label>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void action(async () => {
                        const result = await post("instruments", {
                          market,
                          query,
                          offset: 0,
                        });
                        setItems(result.items);
                        setSelected(null);
                        invalidate();
                      })
                    }
                  >
                    Search contracts
                  </Button>
                  <label>
                    Contract
                    <select
                      value={selected?.masterToken ?? ""}
                      onChange={(e) => {
                        const row =
                          items.find((i) => i.masterToken === e.target.value) ??
                          null;
                        setSelected(row);
                        setQuantity(row ? String(row.lotSize) : "");
                        invalidate();
                      }}
                    >
                      <option value="">Select exact contract</option>
                      {items.map((i) => (
                        <option key={i.masterToken} value={i.masterToken}>
                          {i.name} · lot {i.lotSize}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Side
                    <select
                      value={side}
                      onChange={(e) => {
                        setSide(e.target.value as "buy" | "sell");
                        invalidate();
                      }}
                    >
                      <option value="buy">Buy</option>
                      <option value="sell">
                        Sell — reduce tracked long only
                      </option>
                    </select>
                  </label>
                  <label>
                    Quantity (exchange units)
                    <input
                      type="number"
                      min="1"
                      value={quantity}
                      onChange={(e) => {
                        setQuantity(e.target.value);
                        invalidate();
                      }}
                    />
                  </label>
                  <label>
                    Limit price ₹
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={price}
                      onChange={(e) => {
                        setPrice(e.target.value);
                        invalidate();
                      }}
                    />
                  </label>
                </div>
                <Button
                  disabled={!selected || !quantity || !price}
                  onClick={() =>
                    void action(async () => {
                      const result = await post("preview", {
                        instrument: selected!.masterToken,
                        side,
                        quantity: Number(quantity),
                        limitPaise: Math.round(Number(price) * 100),
                        reduceOnly: side === "sell",
                      });
                      setPreview(result);
                      setProof("");
                    })
                  }
                >
                  Preview real order
                </Button>
              </fieldset>
              {preview && (
                <fieldset disabled={busy || uncertain}>
                  <legend>4. Confirm real-money submission</legend>
                  <p>
                    {preview.intent.side.toUpperCase()}{" "}
                    {preview.intent.quantity} × {preview.tradingSymbol} at{" "}
                    {money(preview.intent.limitPaise)}. Notional{" "}
                    {money(preview.notionalPaise)} before fees. Preview expires
                    at {new Date(preview.expires).toLocaleTimeString()}.
                  </p>
                  <label>
                    Type PLACE LIVE ORDER
                    <input
                      value={proof}
                      onChange={(e) => setProof(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <Button
                    disabled={
                      proof !== "PLACE LIVE ORDER" ||
                      Date.now() >= preview.expires
                    }
                    onClick={() =>
                      void action(async () => {
                        try {
                          const result = await post("orders", {
                            previewId: preview.previewId,
                            confirmation: proof,
                          });
                          setMessage(
                            `Order status: ${result.state}. Check broker reconciliation for final fills.`,
                          );
                          if (["unknown", "submitting"].includes(result.state))
                            setUncertain(true);
                          invalidate();
                          await refresh();
                        } catch (e) {
                          setUncertain(true);
                          throw e;
                        }
                      })
                    }
                  >
                    Place live order
                  </Button>
                </fieldset>
              )}
              {uncertain && (
                <p role="alert">
                  Submission outcome needs review. New tickets are locked in
                  this view. Reconcile and check Kotak before continuing; do not
                  recreate this order.
                </p>
              )}
              <Button
                variant="secondary"
                onClick={() =>
                  void action(async () => {
                    await post("halt");
                    invalidate();
                    await refresh();
                    setMessage(
                      "Live halted. Cancellation requested—not guaranteed. Check broker orders and remaining positions.",
                    );
                  })
                }
              >
                HALT LIVE + request cancellation
              </Button>
              <table>
                <thead>
                  <tr>
                    <th>Intent</th>
                    <th>Side / quantity</th>
                    <th>State</th>
                    <th>Broker order</th>
                    <th>Filled units</th>
                  </tr>
                </thead>
                <tbody>
                  {status?.orders?.map((o) => (
                    <tr key={o.id}>
                      <td>{o.intent.instrument}</td>
                      <td>
                        {o.intent.side} / {o.intent.quantity}
                      </td>
                      <td>{o.state}</td>
                      <td>
                        {o.brokerOrder?.brokerOrderId ??
                          "Awaiting confirmation"}
                      </td>
                      <td>{o.brokerOrder?.filledQuantity ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
