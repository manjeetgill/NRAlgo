"use client";

/** Live UI is deliberately separate from the paper strategy forms. Selecting this page
 * does not enable money movement; activation and each immutable order preview are explicit.
 * Credentials stay in the existing Brokers form; passwords/MFA never enter localStorage.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button";

type Intent = {
  instrument: string;
  side: string;
  quantity: number;
  limitPaise: number;
};
/** A research handoff is an editable suggestion, never an authorized or submitted order. */
export type LiveOrderDraft = {
  stockCode: string;
  side: "buy" | "sell";
  quantity: number;
  limitPaise: number;
};
type LiveStatus = {
  connected: boolean;
  armed: boolean;
  halted: boolean;
  reason: string;
  armedUntil?: number;
  reconciledAt?: number;
  snapshot: {
    availablePaise: number;
    dailyPnlPaise: number;
    positions: Record<string, number>;
  } | null;
  orders: {
    id: string;
    state: string;
    intent: Intent;
    broker_order: { brokerOrderId: string; filledQuantity: number } | null;
  }[];
};
type Preview = {
  previewId: string;
  intent: Intent;
  notionalPaise: number;
  expiresAt: number;
};
const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    paise / 100,
  );
/** Same-origin session/CSRF wrapper. An ambiguous timeout is shown; never retry an order POST. */
async function liveRequest(path: string, csrf: string, body?: unknown) {
  const response = await fetch(`/api/live/icici${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    signal: AbortSignal.timeout(100000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.detail ||
        "Live request failed. Verify broker state before retrying.",
    );
  return result;
}

/** Render connection, short-lived activation, order review, broker-confirmed history and kill. */
export function LiveTradingPanel({
  csrf,
  onPaper,
  draft,
}: {
  csrf: string;
  onPaper: () => void;
  draft?: LiveOrderDraft;
}) {
  const [status, setStatus] = useState<LiveStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    let cancelled = false,
      polling = false;
    async function refresh() {
      if (polling) return;
      polling = true;
      try {
        const result = await liveRequest("", csrf);
        if (!cancelled) setStatus(result);
      } catch (error) {
        if (!cancelled) {
          setStatus(null);
          setError((error as Error).message);
        }
      } finally {
        polling = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [csrf]);
  /** Serialize mutations; refresh safe cached status afterwards without replaying failed calls. */
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setStatus(await liveRequest("", csrf));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** Revocation is an API action, not just navigation. Keep the user on-screen if cancellation
   * is unresolved so they can verify outstanding exposure at ICICI before leaving.
   */
  function stopLive(returnToPaper = false) {
    void act(async () => {
      const result = await liveRequest("/halt", csrf, {});
      setPreview(null);
      if (result.unresolved?.length) {
        setError(
          "Live submissions are halted, but cancellation is unresolved. Check pending orders directly in ICICI Direct.",
        );
        return;
      }
      setNotice(
        "Live submissions halted. Cancellation requested; positions were not sold.",
      );
      if (returnToPaper) onPaper();
    });
  }
  /** Activation proves current password/MFA and acknowledges real-money/static-IP requirements. */
  function arm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    const payload = {
      password: String(data.get("password")),
      token: String(data.get("token")),
      capitalInr: Number(data.get("capitalInr")),
      confirmation: String(data.get("confirmation")),
      staticIpConfirmed: data.get("staticIpConfirmed") === "on",
    };
    form.reset();
    void act(async () => {
      setStatus(await liveRequest("/arm", csrf, payload));
      setNotice(
        "Live permission enabled for 15 minutes. Orders still require separate confirmation.",
      );
    });
  }
  /** Create a server-stored preview. A BUY/SELL form submission never places the real order. */
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPreview(null);
    void act(async () => {
      setPreview(
        await liveRequest("/preview", csrf, {
          stockCode: String(data.get("stockCode")).toUpperCase(),
          side: data.get("side"),
          quantity: Number(data.get("quantity")),
          limitPaise: Math.round(Number(data.get("limit")) * 100),
        }),
      );
    });
  }
  return (
    <section className="live-panel" aria-label="ICICI live trading">
      <div className="environment is-paused">
        <div>
          <strong>ICICI Direct · REAL MONEY</strong>
          <span>
            Separate from paper strategies. NSE cash · Limit orders · No short
            selling or derivatives.
          </span>
        </div>
        <span className="badge">
          {status?.armed ? "LIVE ARMED" : "LIVE HALTED"}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="live-actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => stopLive(true)}
        >
          Switch to paper
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await liveRequest("/connect", csrf, {});
              setNotice(
                "ICICI checked. Review account state before enabling live.",
              );
            })
          }
        >
          Connect / verify ICICI
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !status?.connected}
          onClick={() =>
            void act(async () => {
              await liveRequest("/refresh", csrf, {});
            })
          }
        >
          Reconcile now
        </Button>
        <Button variant="danger" onClick={() => stopLive()}>
          Kill live submissions & cancel pending
        </Button>
      </div>
      <p>
        Save your API key, API secret and login API_Session under{" "}
        <strong>Brokers</strong>, then enable authenticator MFA under{" "}
        <strong>Account & security</strong>. The server’s outbound static IP
        must be registered with ICICI. Never paste keys into chat or GitHub.
      </p>
      <p role="status">
        {status?.reason || "Broker state loaded."}{" "}
        {status?.reconciledAt
          ? `Last reconciliation: ${new Date(status.reconciledAt).toLocaleTimeString()}`
          : ""}
      </p>
      <div className="live-grid">
        <article className="panel">
          <h2>Enable live trading</h2>
          <p>
            Permission expires after 15 minutes, logout, session loss or server
            restart. Maximum allocation: ₹5,000 for this initial release.
          </p>
          <form onSubmit={arm} className="live-form">
            <label>
              Live capital budget (₹)
              <input
                name="capitalInr"
                type="number"
                min="100"
                max="5000"
                defaultValue="1000"
                required
              />
            </label>
            <label>
              App account password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              Fresh authenticator / recovery code
              <input name="token" autoComplete="one-time-code" required />
            </label>
            <label>
              Type ENABLE LIVE TRADING
              <input
                name="confirmation"
                autoComplete="off"
                required
                pattern="ENABLE LIVE TRADING"
              />
            </label>
            <label>
              <input name="staticIpConfirmed" type="checkbox" required /> I
              confirmed the server’s registered static IP and understand this
              uses real money.
            </label>
            <Button disabled={busy || !status?.connected}>
              Enable live for 15 minutes
            </Button>
          </form>
        </article>
        <article className="panel">
          <h2>Review a live limit order</h2>
          <p>
            Sell only reduces a same-day position opened through this app.
            Existing paper strategies are not converted into live strategies.
          </p>
          <form onSubmit={review} className="live-form">
            <label>
              Breeze stock code
              <input
                name="stockCode"
                defaultValue={draft?.stockCode}
                placeholder="e.g. RELIND"
                required
                maxLength={30}
              />
            </label>
            <label>
              Action
              <select name="side" defaultValue={draft?.side || "buy"}>
                <option value="buy">Buy cash</option>
                <option value="sell">
                  Sell — reduce existing position only
                </option>
              </select>
            </label>
            <label>
              Quantity
              <input
                name="quantity"
                type="number"
                min="1"
                max="100"
                defaultValue={draft?.quantity || 1}
                required
              />
            </label>
            <label>
              Limit price (₹)
              <input
                name="limit"
                defaultValue={draft ? draft.limitPaise / 100 : undefined}
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </label>
            <Button disabled={busy || !status?.armed}>
              Review order — no submission yet
            </Button>
          </form>
          {preview && (
            <div
              className="live-confirm"
              role="region"
              aria-label="Confirm real-money order"
            >
              <h3>Confirm REAL order</h3>
              <p>
                {preview.intent.side.toUpperCase()} {preview.intent.quantity} ×{" "}
                {preview.intent.instrument} at limit{" "}
                {inr(preview.intent.limitPaise)}. Notional:{" "}
                {inr(preview.notionalPaise)} plus charges.
              </p>
              <p>
                Valid until {new Date(preview.expiresAt).toLocaleTimeString()}.
                This sends an order to ICICI Direct.
              </p>
              <Button
                disabled={
                  busy || !status?.armed || Date.now() > preview.expiresAt
                }
                onClick={() =>
                  void act(async () => {
                    const result = await liveRequest("/orders", csrf, {
                      previewId: preview.previewId,
                      confirmation: "PLACE LIVE ORDER",
                    });
                    setNotice(`${result.message} State: ${result.state}.`);
                    setPreview(null);
                  })
                }
              >
                Confirm & place REAL order
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Discard preview
              </Button>
            </div>
          )}
        </article>
      </div>
      {status?.snapshot && (
        <p>
          Broker available cash (last snapshot):{" "}
          {inr(status.snapshot.availablePaise)} · Marked same-day P&L:{" "}
          {inr(status.snapshot.dailyPnlPaise)} · Positions:{" "}
          {Object.entries(status.snapshot.positions)
            .map(([symbol, quantity]) => `${symbol}: ${quantity}`)
            .join(", ") || "Flat"}
        </p>
      )}
      <article className="panel">
        <h2>Live order history</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Side / qty</th>
                <th>Limit</th>
                <th>State</th>
                <th>Filled</th>
                <th>Broker order ID</th>
              </tr>
            </thead>
            <tbody>
              {status?.orders.map((order) => (
                <tr key={order.id}>
                  <td>{order.intent.instrument}</td>
                  <td>
                    {order.intent.side} {order.intent.quantity}
                  </td>
                  <td>{inr(order.intent.limitPaise)}</td>
                  <td>{order.state}</td>
                  <td>{order.broker_order?.filledQuantity ?? "Unconfirmed"}</td>
                  <td>
                    {order.broker_order?.brokerOrderId ||
                      "Awaiting broker evidence"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Unknown outcomes must be checked at ICICI; do not create another order
          to retry them. A halt requests cancellation but does not flatten
          positions. Background reconciliation runs every 45 seconds; each
          submission also requires fresh checks.
        </p>
      </article>
    </section>
  );
}
