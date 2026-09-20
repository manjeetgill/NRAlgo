"use client";
/** Real account sessions: server-issued metadata only, never invented device or activity information. */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
type SessionRecord = { id: string; current: boolean; expiresAt: number };
/** List and explicitly revoke owner-scoped sessions; revocation may close the broker data connection. */
export function AccountSessions({ csrf }: { csrf: string }) {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const confirm = useConfirm();
  const toast = useToast();
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
      !(await confirm({
        title: "Revoke this access?",
        description:
          "Broker connections will close, but exchange positions will remain open.",
        confirmLabel: "Revoke access",
        tone: "danger",
      }))
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
      toast({
        tone: "success",
        title: id ? "Session revoked" : "Other sessions signed out",
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Session revocation failed.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const columns: DataTableColumn<SessionRecord>[] = [
    {
      key: "session",
      header: "Session",
      render: (session) =>
        session.current
          ? "Current session"
          : `Session ${session.id.slice(0, 8)}`,
    },
    { key: "device", header: "Device", render: () => "Not recorded" },
    {
      key: "expires",
      header: "Expires (IST)",
      sortValue: (session) => session.expiresAt,
      render: (session) =>
        new Date(session.expiresAt).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        }),
    },
    {
      key: "action",
      header: "Action",
      render: (session) =>
        session.current ? (
          <Badge tone="accent">Current</Badge>
        ) : (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void revoke(session.id)}
          >
            Revoke session
          </Button>
        ),
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <Button variant="secondary" disabled={busy} onClick={() => void load()}>
          Refresh sessions
        </Button>
      </CardHeader>
      {error && <p role="alert">{error}</p>}
      <DataTable
        columns={columns}
        rows={sessions ?? []}
        rowKey={(session) => session.id}
        emptyTitle="No sessions loaded yet"
      />
      <p style={{ marginTop: "var(--space-4)" }}>
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
    </Card>
  );
}
