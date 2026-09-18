"use client";

/** Authentication and workspace snapshots have one lifecycle owner; screens never keep copies of session state. */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import type { AuthStatus, WorkspaceSnapshot } from "./workspace-types";
import { createLatestRequest } from "@/lib/latest-request";
import { parseAuthStatus, parseWorkspaceSnapshot } from "./workspace-api";

/** Manage account entry/exit, abortable reads and bounded polling of active synthetic jobs only. */
export function useWorkspaceSession() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const readGate = useRef(createLatestRequest());
  const mounted = useRef(false);
  const mutationPending = useRef(false);

  /** Cancel superseded reads before beginning another; recheck identity after every awaited response. */
  const onRefresh = useCallback(async () => {
    if (!mounted.current) {
      return;
    }
    const request = readGate.current.begin();
    try {
      const next = parseWorkspaceSnapshot(
        await requestApiJson(
          "/workspace",
          "GET",
          undefined,
          undefined,
          15000,
          request.signal,
        ),
      );
      if (!mounted.current || !request.isCurrent()) {
        return;
      }
      setWorkspace(next);
      setAuth(null);
      setError("");
    } catch (cause) {
      if (!mounted.current || !request.isCurrent() || request.signal.aborted) {
        return;
      }
      if ((cause as { status?: number }).status !== 401) {
        setError(
          cause instanceof Error ? cause.message : "Workspace unavailable.",
        );
        return;
      }
      setWorkspace(null);
      try {
        const policy = parseAuthStatus(
          await requestApiJson(
            "/auth/status",
            "GET",
            undefined,
            undefined,
            15000,
            request.signal,
          ),
        );
        if (mounted.current && request.isCurrent()) {
          setAuth(policy);
          setError("");
        }
      } catch (failure) {
        if (mounted.current && request.isCurrent() && !request.signal.aborted) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Sign-in policy unavailable.",
          );
        }
      }
    }
  }, []);

  /** Mount one initial read; cleanup invalidates both workspace and nested auth-policy promises. */
  useEffect(() => {
    mounted.current = true;
    void onRefresh(); // All request failures are handled within onRefresh.
    const gate = readGate.current;
    /** Abort network reads on unmount; mutations are never retried or assumed undone. */
    return () => {
      mounted.current = false;
      gate.invalidate();
    };
  }, [onRefresh]);

  const hasRunningJobs = Boolean(
    workspace?.paper_trading_enabled &&
    workspace.jobs.some(
      /** Only queued/running research jobs require periodic workspace reads. */
      (job) => job.status === "queued" || job.status === "running",
    ),
  );
  /** Poll sequentially only while work is active and the document is visible; never overlap intervals. */
  useEffect(() => {
    if (!hasRunningJobs) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    /** Schedule after completion, so a slow request cannot accumulate more pending requests. */
    async function poll() {
      if (stopped) {
        return;
      }
      if (!document.hidden && !mutationPending.current) {
        await onRefresh();
      }
      if (!stopped) {
        timer = setTimeout(poll, 3000);
      }
    }
    timer = setTimeout(poll, 3000);
    /** Stop future work on navigation/session/job completion. */
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hasRunningJobs, onRefresh]);

  /** Guard double submits synchronously and fence responses from an earlier authentication attempt. */
  const onAuthenticate = useCallback(
    async (data: Record<string, FormDataEntryValue>, registering: boolean) => {
      if (!auth || mutationPending.current) {
        return;
      }
      mutationPending.current = true;
      readGate.current.invalidate();
      setBusy(true);
      setError("");
      try {
        await requestApiJson(
          auth.setup_required
            ? "/auth/setup"
            : registering
              ? "/auth/register"
              : "/auth/login",
          "POST",
          data,
        );
        await onRefresh();
      } catch (cause) {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : "Sign in failed.");
        }
      } finally {
        mutationPending.current = false;
        if (mounted.current) {
          setBusy(false);
        }
      }
    },
    [auth, onRefresh],
  );

  /** Revoke the session explicitly; old reads cannot restore private UI while logout is pending. */
  const onSignOut = useCallback(async () => {
    if (!workspace || mutationPending.current) {
      return;
    }
    mutationPending.current = true;
    readGate.current.invalidate();
    setBusy(true);
    setError("");
    try {
      await requestApiJson("/auth/logout", "POST", {}, workspace.csrf);
      if (mounted.current) {
        setWorkspace(null);
      }
      await onRefresh();
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Sign out failed; check your session.",
        );
      }
    } finally {
      mutationPending.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [workspace, onRefresh]);

  /** Clear a presentation error without changing account state. */
  const onClearError = useCallback(() => setError(""), []);
  return {
    workspace,
    auth,
    error,
    busy,
    onRefresh,
    onAuthenticate,
    onSignOut,
    onClearError,
  };
}
