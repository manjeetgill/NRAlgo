"use client";

/** Application-account password and MFA settings.
 * Secrets exist only in the submitted form or short-lived enrollment state; never localStorage.
 * Sensitive operations call authenticated, CSRF-protected server routes.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Dialog, DialogActions } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
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
  const toast = useToast();
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
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const passwordFormRef = useRef<HTMLFormElement>(null);
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
        toast({
          tone: "success",
          title: data.enabled ? "MFA enabled" : "MFA disabled",
        });
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
      setPasswordDialogOpen(false);
      await onRefresh();
      setMessage("Password changed. All previous sessions were revoked.");
      toast({ tone: "success", title: "Password changed" });
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
        <Card>
          <CardTitle>Profile</CardTitle>
          <Field label="Username" htmlFor="account-username">
            <Input id="account-username" readOnly value={username} />
          </Field>
          <Button
            variant="secondary"
            disabled={mfaEnabled === null}
            onClick={() => setPasswordDialogOpen(true)}
          >
            Change password
          </Button>
        </Card>
        <Dialog
          open={passwordDialogOpen}
          onClose={() => {
            setPasswordDialogOpen(false);
            passwordFormRef.current?.reset();
          }}
          title="Change password"
          labelledBy="change-password-title"
        >
          {error && <p role="alert">{error}</p>}
          <form ref={passwordFormRef} onSubmit={changePassword}>
            <Field label="Current password" htmlFor="current-password">
              <Input
                id="current-password"
                name="current_password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </Field>
            <Field label="New password" htmlFor="new-password">
              <Input
                id="new-password"
                name="new_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </Field>
            {mfaEnabled && (
              <Field
                label="Authenticator or recovery code"
                htmlFor="password-mfa-token"
              >
                <Input
                  id="password-mfa-token"
                  name="token"
                  autoComplete="one-time-code"
                  required
                  maxLength={32}
                />
              </Field>
            )}
            <DialogActions>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setPasswordDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button disabled={busy}>Change password</Button>
            </DialogActions>
          </form>
        </Dialog>
        <Card>
          <CardTitle>
            Two-factor authentication ·{" "}
            {mfaEnabled === null
              ? "Unknown"
              : mfaEnabled
                ? "Enabled"
                : "Not enabled"}
          </CardTitle>
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
            <Field
              label="One-time setup key"
              htmlFor="mfa-setup-key"
              hint="Keep this private. Setup expires after 10 minutes."
            >
              <Input
                id="mfa-setup-key"
                readOnly
                value={enrollmentSecret}
                aria-label="Authenticator setup key"
              />
            </Field>
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
                <Field label="Current password" htmlFor="mfa-password">
                  <Input
                    id="mfa-password"
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                  />
                </Field>
              )}
              {(enrollmentSecret || mfaEnabled) && (
                <Field
                  label={
                    mfaEnabled
                      ? "Fresh authenticator or unused recovery code"
                      : "6-digit authenticator code"
                  }
                  htmlFor="mfa-token"
                >
                  <Input
                    id="mfa-token"
                    name="token"
                    autoComplete="one-time-code"
                    required
                    maxLength={32}
                  />
                </Field>
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
        </Card>
      </div>
      <AccountSessions csrf={csrf} />
    </section>
  );
}
