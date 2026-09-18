"use client";
/** Real account sessions: server-issued metadata only, never invented device or activity information. */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
type SessionRecord = { id: string; current: boolean; expiresAt: number };
/** List and explicitly revoke owner-scoped sessions; revocation may close the broker data connection. */
export function AccountSessions({ csrf }: { csrf: string }) {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  /** Read bounded session metadata and discard results belonging to a departed screen. */
  const load = useCallback(async () => {
    const version = ++generation.current;
    try {
      const result = await requestApiJson("/auth/sessions");
      if (!Array.isArray(result.sessions)) {
        throw new Error("Session list unavailable.");
      }
      if (version === generation.current) {
        setSessions(result.sessions);
        setError("");
      }
    } catch (cause) {
      if (version === generation.current) {
        setError(
          cause instanceof Error ? cause.message : "Session list unavailable.",
        );
      }
    }
  }, []);
  /** Initial account read has no revocation side effects. */
  useEffect(() => {
    void load();
    const gate = generation;
    return () => {
      gate.current++;
    };
  }, [load]);
  /** User confirmation precedes one CSRF-protected revoke; the current session cannot be selected. */
  async function revoke(id?: string) {
    if (
      pending.current ||
      !window.confirm(
        "Revoke this access? Broker connections will close, but exchange positions will remain open.",
      )
    ) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await requestApiJson(
        id ? "/auth/sessions/revoke" : "/auth/revoke-sessions",
        "POST",
        id ? { id } : {},
        csrf,
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Session revocation failed.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel screen-card">
      <div className="screen-toolbar">
        <h2>Active sessions</h2>
        <Button variant="secondary" disabled={busy} onClick={() => void load()}>
          Refresh sessions
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Device</th>
              <th>Expires (IST)</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {sessions?.map((session) => (
              <tr key={session.id}>
                <td>
                  {session.current
                    ? "Current session"
                    : `Session ${session.id.slice(0, 8)}`}
                </td>
                <td>Not recorded</td>
                <td>
                  {new Date(session.expiresAt).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  })}
                </td>
                <td>
                  {session.current ? (
                    "Current"
                  ) : (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void revoke(session.id)}
                    >
                      Revoke session
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Device identity and last-active timestamps are not collected. Revoking
        access does not close broker positions.
      </p>
      <Button
        variant="secondary"
        disabled={busy || !sessions?.some((session) => !session.current)}
        onClick={() => void revoke()}
      >
        Sign out other devices
      </Button>
    </section>
  );
}
