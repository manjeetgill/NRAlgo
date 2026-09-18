"use client";

/** Application-account password and MFA settings.
 * Secrets exist only in the submitted form or short-lived enrollment state; never localStorage.
 * Sensitive operations call authenticated, CSRF-protected server routes.
 */

import { useEffect, useState, type FormEvent } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "./ui/button";

/** Send same-origin authenticated JSON, with CSRF and a deadline longer than SDK authentication. */
function requestAuthenticatedJson(
  path: string,
  csrf: string,
  method = "GET",
  body?: unknown,
) {
  return requestApiJson(path, method, body, csrf, 100000);
}

/** Manage application credentials and MFA without changing broker credentials. */
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
