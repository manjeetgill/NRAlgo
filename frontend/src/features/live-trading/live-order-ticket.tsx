"use client";
/** Explicit real-money ticket, separate from simulated ledgers. Never submits on mount or retry. */
import { useCallback, useEffect, useRef, useState } from "react";
import { createLatestRequest } from "@/lib/latest-request";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { BrokerInstrument } from "@/components/instrument-picker";

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
  activeBrokerId?: string;
  provider?: string;
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

/** Render explicit live controls, retaining server, MFA, risk and confirmation safeguards. */
export function LiveOrderTicket({
  csrf,
  initialOrder,
}: {
  csrf: string;
  initialOrder?: { contract: BrokerInstrument; side: "buy" | "sell" };
}) {
  const statusGate = useRef(createLatestRequest());
  const actionPending = useRef(false);
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
  const [market, setMarket] = useState<"cash" | "options">(
      initialOrder ? "options" : "cash",
    ),
    [query, setQuery] = useState(initialOrder?.contract.symbol ?? "");
  const [items, setItems] = useState<BrokerInstrument[]>([]),
    [selected, setSelected] = useState<BrokerInstrument | null>(null);
  const [side, setSide] = useState<"buy" | "sell">(initialOrder?.side ?? "buy"),
    [quantity, setQuantity] = useState(
      initialOrder ? String(initialOrder.contract.lotSize) : "",
    ),
    [price, setPrice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [proof, setProof] = useState("");
  const [uncertain, setUncertain] = useState(false);
  /** Read control status without arming, reconciling or submitting orders. */
  const refresh = useCallback(async () => {
    const read = statusGate.current.begin();
    const result = await requestApiJson(
      "/live/status",
      "GET",
      undefined,
      undefined,
      15000,
      read.signal,
    );
    if (read.isCurrent()) {
      setStatus(result);
      setConfigured(Boolean(result.accountId));
    }
    return result;
  }, []);
  /** Load status once and cancel obsolete reads on account change/unmount; never cancel or retry a submitted order here. */
  useEffect(() => {
    let active = true;
    void refresh().catch(
      /** Ignore failures from a departed account view. */ (e) => {
        if (active) {
          setError(e.message);
        }
      },
    );
    const gate = statusGate.current;
    /** Read cancellation changes UI ownership only, not broker state. */
    return () => {
      active = false;
      gate.invalidate();
    };
  }, [csrf, refresh]);
  /** Run explicit UI work with busy/error feedback; never automatically retry uncertain submissions. */
  async function action(work: () => Promise<void>) {
    if (actionPending.current) {
      return;
    }
    actionPending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  const post = (path: string, body: unknown = {}) =>
    requestApiJson(`/live/${path}`, "POST", body, csrf, 30000);
  /** Discard reviewed previews when inputs change so old confirmations cannot authorize different terms. */
  function invalidate() {
    setPreview(null);
    setProof("");
  }
  /** Halt account dispatch before requesting cancellation and then refresh broker-backed control state. */
  async function requestLiveTradingDisable() {
    await post("halt");
    invalidate();
    await refresh();
    setMessage(
      "Live trading disabled. Cancellation was requested but is not guaranteed; verify broker orders and positions.",
    );
  }
  /** Serialize the explicit disable action through the shared pending-action guard. */
  function handleLiveTradingDisable() {
    void action(requestLiveTradingDisable);
  }
  return (
    <section
      className="research-panel live-execution-panel"
      aria-label="Live execution controls"
    >
      <div className="panel-heading">
        <div>
          <h2>Live execution</h2>
          <p>Connected broker · LIMIT / DAY · NSE cash and long options</p>
          {initialOrder && (
            <p>
              From option chain: {initialOrder.contract.symbol}. Search and
              select the exact contract from the active broker before reviewing.
              Chain tokens and prices are never used as execution authorization.
              Selling only reduces a tracked long position.
            </p>
          )}
        </div>
      </div>
      <fieldset disabled={busy}>
        <legend>Live trading control</legend>
        <p role="status">
          Server capability: {status?.enabled ? "Available" : "Locked"} · Live
          trading: {status?.armed ? "Enabled" : "Disabled"} · Active broker:{" "}
          {status?.provider?.toUpperCase() ?? "Not selected"}. {status?.reason}
        </p>
        <p>
          Enabling is temporary and requires reconciliation, an authenticator
          code and explicit confirmation. Disabling blocks new submissions
          first, then requests cancellation of non-terminal broker orders.
        </p>
        {configured && status?.enabled && (
          <Button variant="danger" onClick={handleLiveTradingDisable}>
            Disable live trading + cancel pending orders
          </Button>
        )}
      </fieldset>
      <p>
        Use a dedicated trading account. Only reconciled, app-tracked exposure
        can be managed here; unexplained positions or unknown order outcomes
        require review. Every live order requires explicit authorization.
      </p>
      <p>
        Funds use the active broker&apos;s available buying power, not a settled
        cash ledger. Halting requests cancellation of app-managed orders; it
        does not close positions.
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
                <legend>2. Enable live trading for five minutes</legend>
                <label>
                  Fresh app authenticator or unused recovery code
                  <input
                    type="password"
                    autoComplete="one-time-code"
                    maxLength={32}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <p>
                  Use a new code for each authorization. If you just changed
                  brokers, wait for your authenticator to show its next code.
                </p>
                <label>
                  Type ENABLE REAL MONEY
                  <input
                    value={armProof}
                    onChange={(e) => setArmProof(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <Button
                  disabled={
                    status?.armed || armProof !== "ENABLE REAL MONEY" || !token
                  }
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
                  Enable live trading
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
                    Search active broker contract
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
                          if (
                            ["unknown", "submitting"].includes(result.state)
                          ) {
                            setUncertain(true);
                          }
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
                  this view. Reconcile and check the active broker before
                  continuing; do not recreate this order.
                </p>
              )}
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
