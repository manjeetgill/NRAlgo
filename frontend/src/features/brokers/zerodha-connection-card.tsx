"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { requestApiJson } from "@/lib/api";

const connectionSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  callbackUrl: z.string().url(),
  account: z.object({ user_id: z.string(), user_name: z.string() }).nullable(),
});

/** Independent broker login: all SDK credentials and access tokens stay on Express. */
export function ZerodhaConnectionCard({ csrf }: { csrf: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [connection, setConnection] = useState<z.infer<
    typeof connectionSchema
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    requestApiJson(
      "/brokers/zerodha",
      "GET",
      undefined,
      undefined,
      15000,
      abort.signal,
    )
      .then((data) => {
        if (!abort.signal.aborted) {
          setConnection(connectionSchema.parse(data));
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError(
            "Unable to load Zerodha status. Check that the updated API is running.",
          );
        }
      });
    return () => abort.abort();
  }, []);
  async function action(kind: "login" | "verify" | "disconnect") {
    if (busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await requestApiJson(
        `/brokers/zerodha/${kind}`,
        "POST",
        {},
        csrf,
      );
      if (kind === "login") {
        const url = new URL(
          z.object({ url: z.string().url() }).parse(result).url,
        );
        if (
          url.protocol !== "https:" ||
          !["kite.zerodha.com", "kite.trade"].includes(url.hostname)
        ) {
          throw new Error("Unexpected login destination.");
        }
        window.location.assign(url.href);
      } else {
        setConnection(connectionSchema.parse(result));
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to update Zerodha connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <article className="panel screen-card" aria-label="Zerodha connection">
        <div className="screen-toolbar">
          <h2 className="broker-card-title">
            <span className="connection-logo">Z</span>Zerodha Kite
          </h2>
          <span className="badge" role="status">
            {!connection
              ? "Checking connection…"
              : connection.connected
                ? "Authorized · connected"
                : connection.configured
                  ? "Not authorized"
                  : "Setup required"}
          </span>
        </div>
        <p>
          Authorize this app to access your Zerodha account through Kite APIs.
          Sign in securely on Zerodha, then return here to finish authorization.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <dl className="broker-connection-facts">
          <dt>Account</dt>
          <dd>
            {connection?.account
              ? `${connection.account.user_name} · ${connection.account.user_id}`
              : "No verified Zerodha session"}
          </dd>
          <dt>Access</dt>
          <dd>
            Authorized API session and profile verification. Portfolio,
            market-data screens and order routing are not yet integrated with
            Zerodha.
          </dd>
          <dt>Execution</dt>
          <dd>Disabled · connecting does not authorize trading</dd>
        </dl>
        <div className="screen-toolbar">
          <Button
            disabled={busy || !connection?.configured}
            onClick={() => void action("login")}
          >
            {busy
              ? "Please wait…"
              : connection?.connected
                ? "Reauthorize with Zerodha"
                : "Authorize with Zerodha"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void action("verify")}
          >
            Verify Zerodha session
          </Button>
          {connection?.connected && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void action("disconnect")}
            >
              Disconnect Zerodha
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => dialog.current?.showModal()}
          >
            Set up Zerodha
          </Button>
        </div>
        <p>
          Sessions are held only on this server until logout, restart or expiry.
          Disconnect removes this app’s session, not your login on Zerodha’s
          website.
        </p>
        {connection && !connection.configured && (
          <p>
            Configure your Kite app on the server to enable authorization. Open
            Set up Zerodha for instructions.
          </p>
        )}
      </article>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        aria-labelledby="zerodha-setup-title"
      >
        <div className="screen-toolbar">
          <h2 id="zerodha-setup-title">Set up Zerodha Kite</h2>
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Close Zerodha setup
          </Button>
        </div>
        <ol>
          <li>
            Create an app in the{" "}
            <a
              href="https://developers.kite.trade/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Kite developer portal
            </a>
            .
          </li>
          <li>
            Register this exact redirect URL:
            <p>
              <code>
                {connection?.callbackUrl ??
                  "Start the updated API to load your callback URL."}
              </code>
            </p>
          </li>
          <li>
            Set <code>ZERODHA_API_KEY</code> and <code>ZERODHA_API_SECRET</code>{" "}
            in the server environment, then restart the API. Set{" "}
            <code>APP_ORIGIN</code> to your public HTTPS app address in
            production.
          </li>
          <li>
            Click Authorize with Zerodha, sign in on Zerodha, then click
            Complete authorization when returned to this app.
          </li>
        </ol>
        <p>
          Never paste the API secret into chat or frontend code. No passwords or
          OTPs are collected here. Your Kotak connection is independent.
        </p>
      </dialog>
    </>
  );
}
