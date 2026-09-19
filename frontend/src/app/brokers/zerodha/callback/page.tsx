"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { requestApiJson } from "@/lib/api";

/** Capture once, immediately erase the URL token; never persist it in browser storage. */
export default function ZerodhaCallbackPage() {
  const token = useRef<{ state: string; request_token: string } | null>(null);
  const captured = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Preparing secure callback…");
  useEffect(() => {
    if (captured.current) {
      return;
    }
    captured.current = true;
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    const parsed = z
      .object({
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        request_token: z.string().min(1).max(256),
      })
      .safeParse({
        state: params.get("state"),
        request_token: params.get("request_token"),
      });
    if (!parsed.success || params.get("status") === "error") {
      setMessage(
        "Zerodha login was cancelled or the callback is incomplete. Return to Broker connections and start again.",
      );
      return;
    }
    token.current = parsed.data;
    setReady(true);
    setMessage(
      "Complete authorization using your existing app session. The server will establish an API session and verify your Zerodha profile. No orders will be placed.",
    );
  }, []);
  async function complete() {
    if (!token.current || busy) {
      return;
    }
    const input = token.current;
    token.current = null;
    setBusy(true);
    setReady(false);
    try {
      const session = z
        .object({ csrf: z.string().min(1) })
        .parse(await requestApiJson("/brokers/zerodha"));
      await requestApiJson(
        "/brokers/zerodha/callback",
        "POST",
        input,
        session.csrf,
        30000,
      );
      window.location.replace("/#/brokers");
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Connection failed. Start a new login.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="screen-stack">
      <section
        className="panel screen-card"
        aria-label="Complete Zerodha connection"
      >
        <h1>Authorize with Zerodha</h1>
        <p role="status">{message}</p>
        <Button disabled={!ready || busy} onClick={() => void complete()}>
          {busy ? "Authorizing…" : "Complete authorization"}
        </Button>
        <p>
          <a href="/#/brokers">Return to Broker connections</a>
        </p>
      </section>
    </main>
  );
}
