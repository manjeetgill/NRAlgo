"use client";

/** Manual, explicit broker-login handoff. This page does not bind an account or save a token.
 * It removes the callback query from browser history and holds the token only in component memory.
 * Users confirm the association by pasting their own token into their authenticated Brokers form.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Present the returned API_Session without persisting it or automatically connecting any account. */
export default function BreezeLoginCallback() {
  const [sessionToken, setSessionToken] = useState(""),
    [message, setMessage] = useState("");
  const captured = useRef(false);
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    const params = new URLSearchParams(window.location.search);
    setSessionToken(
      params.get("API_Session") || params.get("api_session") || "",
    );
    window.history.replaceState(null, "", "/breeze-callback");
  }, []);
  return (
    <main className="broker-settings">
      <section className="panel broker-settings">
        <h1>ICICI login returned</h1>
        <p>
          Only continue if you just signed in to your own ICICI account. Copy
          this session token, return to your NRIAlgo Brokers screen and confirm
          the connection there.
        </p>
        {sessionToken ? (
          <>
            <label>
              API session token
              <input type="password" readOnly value={sessionToken} />
            </label>
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(sessionToken);
                  setMessage(
                    "Copied. Paste into Brokers, then close this tab.",
                  );
                } catch {
                  setMessage(
                    "Clipboard unavailable. Select and copy the token from the field.",
                  );
                }
              }}
            >
              Copy session token
            </Button>
          </>
        ) : (
          <p>
            No API_Session was returned. Start again from the Brokers screen.
          </p>
        )}
        <p role="status">{message}</p>
        <a href="/" rel="noreferrer">
          Return to NRIAlgo
        </a>
        <p>
          Refreshing this page clears the token. Never share the callback URL,
          token, password or OTP.
        </p>
      </section>
    </main>
  );
}
