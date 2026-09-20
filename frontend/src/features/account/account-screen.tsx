"use client";

/** Application-account password and MFA settings.
 * Secrets exist only in the submitted form or short-lived enrollment state; never localStorage.
 * Sensitive operations call authenticated, CSRF-protected server routes.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { AccountSessions } from "./account-sessions";

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
export function AccountScreen({
  csrf,
  onRefresh,
  username,
}: {
  csrf: string;
  onRefresh: () => Promise<void>;
  username: string;
}) {
  const [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null),
    [enrollmentSecret, setEnrollmentSecret] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [enrollmentUri, setEnrollmentUri] = useState("");
  // Enrollment material stays in memory and disappears when its setup window ends.
  useEffect(() => {
    if (!enrollmentUri) {
      return;
    }
    const timer = window.setTimeout(() => {
      setEnrollmentSecret("");
      setEnrollmentUri("");
      setMessage("MFA setup expired. Start a new setup.");
    }, 600000);
    return () => window.clearTimeout(timer);
  }, [enrollmentUri]);
  const passwordDialog = useRef<HTMLDialogElement>(null);
  const mutationPending = useRef(false);
  /** Read MFA policy for this app session; never populate an unmounted account screen from an old response. */
  useEffect(() => {
    let active = true;
    void requestAuthenticatedJson("/auth/mfa", csrf)
      .then((data) => {
        if (active) {
          setMfaEnabled(data.enabled);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [csrf]);
  /** Require the password to begin/remove MFA; confirmation proves the authenticator was configured. */
  async function updateMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationPending.current || mfaEnabled === null) {
      return;
    }
    mutationPending.current = true;
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
        setEnrollmentUri(data.uri);
        setRecoveryCodes([]);
      } else {
        setMfaEnabled(data.enabled);
        setEnrollmentSecret("");
        setEnrollmentUri("");
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
      mutationPending.current = false;
      setBusy(false);
    }
  }
  /** Rotate the password and refresh the CSRF token for the newly issued app session. */
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationPending.current || mfaEnabled === null) {
      return;
    }
    mutationPending.current = true;
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
      passwordDialog.current?.close();
      await onRefresh();
      setMessage("Password changed. All previous sessions were revoked.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="screen-stack broker-settings account-security-screen">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <div className="screen-two-columns">
        <article className="panel screen-card">
          <h2>Profile</h2>
          <label>
            Username
            <input readOnly value={username} />
          </label>
          <Button
            variant="secondary"
            disabled={mfaEnabled === null}
            onClick={() => passwordDialog.current?.showModal()}
          >
            Change password
          </Button>
        </article>
        <dialog
          ref={passwordDialog}
          className="workspace-dialog"
          aria-labelledby="change-password-title"
          onClose={(event) =>
            event.currentTarget.querySelector("form")?.reset()
          }
        >
          <div className="screen-toolbar">
            <h2 id="change-password-title">Change password</h2>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => passwordDialog.current?.close()}
            >
              Close password form
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
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
        </dialog>
        <div className="panel screen-card">
          <h2>
            Two-factor authentication ·{" "}
            {mfaEnabled === null
              ? "Unknown"
              : mfaEnabled
                ? "Enabled"
                : "Not enabled"}
          </h2>
          <p>
            {mfaEnabled
              ? "Your authenticator is set up. Keep it available when changing your live broker or authorizing live trading. Never share its codes."
              : "Add NRIAlgo to your authenticator app using the private QR code or setup key. You will confirm setup with a 6-digit code."}
          </p>
          {enrollmentUri && (
            <div>
              <p>
                Scan with your authenticator app, then enter its 6-digit code
                below.
              </p>
              {/* Render locally: the URI contains a secret and must never reach a QR service. */}
              <QRCodeSVG
                value={enrollmentUri}
                size={224}
                marginSize={4}
                title="Private NRIAlgo authenticator setup QR code"
              />
            </div>
          )}
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
          <details open={mfaEnabled !== true}>
            <summary>
              {mfaEnabled
                ? "Manage two-factor authentication"
                : "Set up two-factor authentication"}
            </summary>
            {mfaEnabled && (
              <p>
                Disabling MFA removes this protection and can prevent broker
                authorization. Your current password and a fresh code are
                required.
              </p>
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
                variant={mfaEnabled ? "danger" : "primary"}
                disabled={busy || mfaEnabled === null}
                value={
                  enrollmentSecret
                    ? "confirm"
                    : mfaEnabled
                      ? "disable"
                      : "setup"
                }
              >
                {enrollmentSecret
                  ? "Verify & enable MFA"
                  : mfaEnabled
                    ? "Disable MFA"
                    : "Set up authenticator"}
              </Button>
            </form>
          </details>
          {!!recoveryCodes.length && (
            <div role="status">
              <h4>Recovery codes — shown once</h4>
              <p>
                Each code works once. Store them in your password manager; do
                not share them.
              </p>
              <pre>{recoveryCodes.join("\n")}</pre>
              <Button variant="secondary" onClick={() => setRecoveryCodes([])}>
                I saved these codes
              </Button>
            </div>
          )}
        </div>
      </div>
      <AccountSessions csrf={csrf} />
    </section>
  );
}
