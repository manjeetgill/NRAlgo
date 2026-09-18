"use client";

/** Broker connection/data UI and application-account security settings.
 * Secrets exist only in the submitted form or short-lived enrollment state; never localStorage.
 * All broker operations call authenticated server routes rather than ICICI directly.
 */

import { useEffect, useState, type FormEvent } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "./ui/button";

/** Send same-origin authenticated JSON, with CSRF and a deadline longer than SDK authentication. */
function requestAuthenticatedJson(path: string, csrf: string, method = "GET", body?: unknown) {
  return requestApiJson(path, method, body, csrf, 100000);
}
type BrokerStatus = {
  saved: boolean;
  state: string;
  updated_at: string | null;
};
type Live = {
  state: string;
  tick: Record<string, string | number> | null;
  receivedAt: number | null;
};
type Candle = Record<string, string | number>;

/** Render the explicit credential handoff and a read-only historical/live data explorer. */
export function BrokerPanel({ csrf }: { csrf: string }) {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false,
      polling = false;
    /** Poll only this user's cached quote; overlapping polls and unmounted updates are suppressed. */
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const [nextStatus, nextLive] = await Promise.all([
          requestAuthenticatedJson("/brokers/icici", csrf),
          requestAuthenticatedJson("/brokers/icici/live", csrf),
        ]);
        if (!cancelled) {
          setStatus(nextStatus);
          setLive(nextLive);
        }
      } catch (e) {
        if (!cancelled) {
          setLive(null);
          setStatus(null);
          setError((e as Error).message);
        }
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [csrf]);
  /** Serialize the UI's mutations and present safe server errors without exposing input secrets. */
  async function runBrokerAction(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setStatus(await requestAuthenticatedJson("/brokers/icici", csrf));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** Submit only the user's explicit credentials, then clear secret fields after success. */
  function connectIciciAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    void runBrokerAction(async () => {
      await requestAuthenticatedJson(
        "/brokers/icici/connect",
        csrf,
        "POST",
        data,
      );
      form.reset();
      setApiKey("");
      setMessage(
        "ICICI connected. You can request historical candles or subscribe to live quotes.",
      );
    });
  }
  /** Convert browser-local dates to UTC and request either candles or one live subscription. */
  function requestMarketData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submit = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const { interval, fromDate, toDate, ...instrument } = values;
    for (const key of ["expiryDate", "right", "strikePrice"])
      if (!instrument[key]) delete instrument[key];
    void runBrokerAction(async () => {
      if (submit?.value === "live") {
        await requestAuthenticatedJson(
          "/brokers/icici/subscribe",
          csrf,
          "POST",
          instrument,
        );
        setLive({ state: "waiting", receivedAt: null, tick: null });
        setMessage(
          "Subscription requested. Quotes appear during market activity; waiting does not mean a live price is available.",
        );
      } else {
        if (!fromDate || !toDate)
          throw new Error("Select both historical dates.");
        const result = await requestAuthenticatedJson(
          "/brokers/icici/historical",
          csrf,
          "POST",
          {
            ...instrument,
            interval,
            fromDate: new Date(String(fromDate)).toISOString(),
            toDate: new Date(String(toDate)).toISOString(),
          },
        );
        setCandles(Array.isArray(result.candles) ? result.candles : []);
        setMessage(
          "Historical response received. Up to 1,000 candles are displayed; empty results can mean no data for that instrument or period.",
        );
      }
    });
  }
  return (
    <section className="broker-workspace">
      <div className="panel broker-settings">
        <div className="panel-heading">
          <div>
            <h3>ICICI Direct · Breeze</h3>
            <p>
              Your own broker account. Read-only market data; live orders remain
              disabled.
            </p>
          </div>
          <span className="badge purple">{status?.state || "CHECKING"}</span>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <p className="info-note" role="status">
            {message}
          </p>
        )}
        <ol className="broker-steps">
          <li>
            Register your Breeze app in{" "}
            <a
              href="https://api.icicidirect.com/apiuser/home"
              target="_blank"
              rel="noopener noreferrer"
            >
              ICICI’s API portal
            </a>
            . Use your own API key and secret. Set its redirect URL to this
            app’s origin followed by <code>/breeze-callback</code> (HTTPS when
            deployed).
          </li>
          <li>
            Enter your API key below, open ICICI login, and authenticate on
            ICICI’s site. Never enter your ICICI password or OTP here.
          </li>
          <li>
            Copy the <code>API_Session</code> value from ICICI’s post-login
            redirect URL and paste only that token below. Renew it when ICICI
            expires the session.
          </li>
        </ol>
        <form onSubmit={connectIciciAccount} autoComplete="off">
          <label>
            API key
            <input
              name="apiKey"
              required
              minLength={8}
              maxLength={256}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          {apiKey.length >= 8 && (
            <a
              className="broker-login"
              href={`https://api.icicidirect.com/apiuser/login?api_key=${encodeURIComponent(apiKey)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open secure ICICI login ↗
            </a>
          )}
          <label>
            API secret
            <input
              name="apiSecret"
              type="password"
              required
              minLength={8}
              maxLength={512}
              autoComplete="new-password"
            />
          </label>
          <label>
            API session token
            <input
              name="sessionToken"
              type="password"
              required
              minLength={4}
              maxLength={1024}
              autoComplete="new-password"
              placeholder="Paste only API_Session, not the full URL"
            />
          </label>
          <p className="broker-help">
            Credentials are encrypted on this server and never sent back to your
            browser. Connection may take up to 90 seconds while Breeze loads its
            instruments.
          </p>
          <div className="broker-actions">
            <Button disabled={busy}>
              {busy ? "Working…" : "Connect & save securely"}
            </Button>
            {status?.saved && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void runBrokerAction(async () => {
                      await requestAuthenticatedJson(
                        "/brokers/icici/reconnect",
                        csrf,
                        "POST",
                        {},
                      );
                      setMessage("Reconnected using your saved credentials.");
                    })
                  }
                >
                  Reconnect saved account
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void runBrokerAction(async () => {
                      await requestAuthenticatedJson(
                        "/brokers/icici",
                        csrf,
                        "DELETE",
                      );
                      setLive(null);
                      setCandles([]);
                      setMessage(
                        "Connection closed and saved credentials removed.",
                      );
                    })
                  }
                >
                  Disconnect & forget
                </Button>
              </>
            )}
          </div>
        </form>
      </div>
      <div className="panel broker-settings">
        <div className="panel-heading">
          <div>
            <h3>Market data explorer</h3>
            <p>
              Use Breeze stock codes, for example RELIND. This data is separate
              from synthetic strategy replays.
            </p>
          </div>
        </div>
        <form onSubmit={requestMarketData}>
          <div className="form-grid">
            <label>
              Stock code
              <input
                name="stockCode"
                defaultValue="RELIND"
                required
                maxLength={30}
              />
            </label>
            <label>
              Exchange
              <select name="exchangeCode">
                <option>NSE</option>
                <option>BSE</option>
                <option>NFO</option>
                <option>BFO</option>
              </select>
            </label>
            <label>
              Product
              <select name="productType">
                <option value="cash">Cash</option>
                <option value="futures">Futures</option>
                <option value="options">Options</option>
              </select>
            </label>
            <label>
              Expiry (derivatives)
              <input name="expiryDate" type="date" />
            </label>
            <label>
              Right
              <select name="right">
                <option value="">Not applicable</option>
                <option value="call">Call</option>
                <option value="put">Put</option>
                <option value="others">Others (futures)</option>
              </select>
            </label>
            <label>
              Strike (options)
              <input
                name="strikePrice"
                inputMode="decimal"
                placeholder="e.g. 25000"
              />
            </label>
            <label>
              Candle interval
              <select name="interval">
                <option value="1minute">1 minute</option>
                <option value="5minute">5 minutes</option>
                <option value="30minute">30 minutes</option>
                <option value="1day">1 day</option>
              </select>
            </label>
            <label>
              From (your local time)
              <input name="fromDate" type="datetime-local" />
            </label>
            <label>
              To (your local time)
              <input name="toDate" type="datetime-local" />
            </label>
          </div>
          <p className="broker-help">
            Intraday requests: maximum one day. Daily candles: maximum one year.
            One live instrument per account. Connections close after 10 minutes
            without use or when the app session expires.
          </p>
          <div className="broker-actions">
            <Button
              disabled={busy || !status || status.state === "disconnected"}
              value="history"
            >
              Load historical candles
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !status || status.state === "disconnected"}
              value="live"
            >
              Subscribe to live quotes
            </Button>
          </div>
        </form>
        <div className="live-quote" aria-live="polite">
          <strong>Feed: {live?.state || "unavailable"}</strong>
          <p>
            {live?.receivedAt
              ? `Last received: ${new Date(live.receivedAt).toLocaleString()}`
              : "No quote received yet. The market may be closed."}
          </p>
          {live?.state === "stale" && (
            <p role="alert">
              No recent ticks. Do not treat this as a current market price.
            </p>
          )}
          {live?.tick && (
            <dl>
              {Object.entries(live.tick).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        {!!candles.length && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {["datetime", "open", "high", "low", "close", "volume"].map(
                    (key) => (
                      <th key={key}>{key.toUpperCase()}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {candles.map((row, i) => (
                  <tr key={i}>
                    {["datetime", "open", "high", "low", "close", "volume"].map(
                      (key) => (
                        <td key={key}>{row[key] ?? "—"}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** Manage application credentials and MFA without changing the user's ICICI password. */
export function AccountPanel({
  csrf,
  onRefresh,
}: {
  csrf: string;
  onRefresh: () => Promise<void>;
}) {
  const [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false),
    [enrollmentSecret, setEnrollmentSecret] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void requestAuthenticatedJson("/auth/mfa", csrf)
      .then((data) => {
        if (active) setMfaEnabled(data.enabled);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [csrf]);
  /** Require the password to begin/remove MFA; confirmation proves the authenticator was configured. */
  async function updateMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const action =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ||
      "setup";
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await requestAuthenticatedJson(
        `/auth/mfa/${action}`,
        csrf,
        "POST",
        Object.fromEntries(new FormData(form)),
      );
      form.reset();
      if (action === "setup") {
        setEnrollmentSecret(data.secret);
        setRecoveryCodes([]);
      } else {
        setMfaEnabled(data.enabled);
        setEnrollmentSecret("");
        setRecoveryCodes(data.recovery_codes || []);
        setMessage(
          data.enabled
            ? "MFA enabled. Save the recovery codes privately before leaving."
            : "MFA disabled. Cloud broker access requires it to be re-enabled.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** Rotate the password and refresh the CSRF token for the newly issued app session. */
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await requestAuthenticatedJson(
        "/auth/password",
        csrf,
        "POST",
        Object.fromEntries(new FormData(form)),
      );
      form.reset();
      await onRefresh();
      setMessage("Password changed. All previous sessions were revoked.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel broker-settings">
      <div className="panel-heading">
        <div>
          <h3>Account security</h3>
          <p>
            Your workspace and broker credentials belong only to your account.
          </p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <form onSubmit={changePassword}>
        <label>
          Current password
          <input
            name="current_password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
        </label>
        <label>
          New password
          <input
            name="new_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        {mfaEnabled && (
          <label>
            Authenticator or recovery code
            <input
              name="token"
              autoComplete="one-time-code"
              required
              maxLength={32}
            />
          </label>
        )}
        <Button disabled={busy}>Change password</Button>
      </form>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await requestAuthenticatedJson(
              "/auth/revoke-sessions",
              csrf,
              "POST",
              {},
            );
            setMessage(
              "Other app sessions revoked. Broker connection closed; reconnect when needed.",
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign out other devices
      </Button>
      <div className="live-quote">
        <h3>Authenticator MFA · {mfaEnabled ? "Enabled" : "Not enabled"}</h3>
        <p>
          Required for broker connections on the cloud server. Add NRIAlgo to
          your authenticator app using a setup key (time-based, 6 digits).
        </p>
        {enrollmentSecret && (
          <label>
            One-time setup key
            <input
              readOnly
              value={enrollmentSecret}
              aria-label="Authenticator setup key"
            />
            <small>Keep this private. Setup expires after 10 minutes.</small>
          </label>
        )}
        <form onSubmit={updateMfa}>
          {!enrollmentSecret && (
            <label>
              Current password
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
              />
            </label>
          )}
          {(enrollmentSecret || mfaEnabled) && (
            <label>
              {mfaEnabled
                ? "Fresh authenticator or unused recovery code"
                : "6-digit authenticator code"}
              <input
                name="token"
                autoComplete="one-time-code"
                required
                maxLength={32}
              />
            </label>
          )}
          <Button
            disabled={busy}
            value={
              enrollmentSecret ? "confirm" : mfaEnabled ? "disable" : "setup"
            }
          >
            {enrollmentSecret
              ? "Verify & enable MFA"
              : mfaEnabled
                ? "Disable MFA"
                : "Set up authenticator"}
          </Button>
        </form>
        {!!recoveryCodes.length && (
          <div role="status">
            <h4>Recovery codes — shown once</h4>
            <p>
              Each code works once. Store them in your password manager; do not
              share them.
            </p>
            <pre>{recoveryCodes.join("\n")}</pre>
            <Button variant="secondary" onClick={() => setRecoveryCodes([])}>
              I saved these codes
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
