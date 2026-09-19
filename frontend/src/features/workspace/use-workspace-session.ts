"use client";

/**
 * One owner for workspace authentication, validated snapshots and cancellation-aware reads.
 * Private parsers guard the browser boundary before any screen consumes server data.
 * Session expiry clears private views; authentication mutations are explicit and never retried.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson, subscribeSessionExpiry } from "@/lib/api";
import type { AuthStatus, WorkspaceSnapshot } from "./workspace-types";
import { createLatestRequest } from "@/lib/latest-request";

/** Manage account entry/exit, abortable reads and explicit snapshot refreshes. */
export function useWorkspaceSession() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const readGate = useRef(createLatestRequest());
  const mounted = useRef(false);
  const mutationPending = useRef(false);
  const expiryPending = useRef(false);

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
      expiryPending.current = false;
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

  /** Expiry on any screen immediately unmounts private data and stops its subscriptions.
   * Fetch only the public sign-in policy; expired background requests cannot cause a refresh loop. */
  useEffect(
    () =>
      subscribeSessionExpiry(() => {
        if (!mounted.current || expiryPending.current) {
          return;
        }
        expiryPending.current = true;
        const request = readGate.current.begin();
        setWorkspace(null);
        setAuth(null);
        setError("Your session expired. Please sign in again.");
        void requestApiJson(
          "/auth/status",
          "GET",
          undefined,
          undefined,
          15000,
          request.signal,
        )
          .then(
            /** Only the latest authentication lifecycle may publish policy. */ (
              result,
            ) => {
              if (mounted.current && request.isCurrent()) {
                setAuth(parseAuthStatus(result));
              }
            },
          )
          .catch(
            /** Keep private data cleared even if the sign-in service is unavailable. */ () => {
              if (mounted.current && request.isCurrent()) {
                setError(
                  "Session expired. Sign-in service unavailable; retry when connected.",
                );
              }
            },
          );
      }),
    [],
  );

  /** Mount one initial read; cleanup invalidates both workspace and nested auth-policy promises. */
  useEffect(() => {
    mounted.current = true;
    let initialReadStarted = false;
    /** Background tabs must not fan out account/report reads during a development reload. */
    function loadWhenVisible() {
      if (!document.hidden && !initialReadStarted) {
        initialReadStarted = true;
        void onRefresh(); // All request failures are handled within onRefresh.
      }
    }
    loadWhenVisible();
    document.addEventListener("visibilitychange", loadWhenVisible);
    const gate = readGate.current;
    /** Abort network reads on unmount; mutations are never retried or assumed undone. */
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", loadWhenVisible);
      gate.invalidate();
    };
  }, [onRefresh]);

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

/** Accept only plain JSON records, excluding null/array payloads. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Missing optional values are allowed; present financial values must be finite numbers. */
function optionalNumber(value: unknown) {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}
/** Verify the fields used by navigation, auth and replay tables before any component consumes them. */
function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (
    !record(value) ||
    typeof value.username !== "string" ||
    !value.username ||
    typeof value.csrf !== "string" ||
    !value.csrf ||
    typeof value.halted !== "boolean" ||
    ![
      "paper_trading_enabled",
      "live_configured",
      "live_submission_enabled",
    ].every(
      /** Absent presentation flags fail closed to live read-only defaults. */ (
        key,
      ) => value[key] === undefined || typeof value[key] === "boolean",
    ) ||
    !Array.isArray(value.strategies) ||
    value.strategies.length > 100 ||
    !value.strategies.every(
      /** Reject malformed strategy rows before rendering names or money. */ (
        row,
      ) =>
        record(row) &&
        ["id", "name", "symbol", "status"].every(
          (key) => typeof row[key] === "string",
        ) &&
        ["fast", "slow", "capital", "pnl"].every(
          (key) => typeof row[key] === "number" && Number.isFinite(row[key]),
        ),
    ) ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 30 ||
    !value.jobs.every(
      /** Replay jobs are not live orders; validate their optional historical fills independently. */ (
        job,
      ) =>
        record(job) &&
        ["id", "strategy_id", "status", "created_at"].every(
          (key) => typeof job[key] === "string",
        ) &&
        record(job.result) &&
        optionalNumber(job.result.pnl) &&
        optionalNumber(job.result.drawdown) &&
        (job.result.trades === undefined ||
          (Array.isArray(job.result.trades) &&
            job.result.trades.length <= 10000 &&
            job.result.trades.every(
              (fill) =>
                record(fill) &&
                typeof fill.side === "string" &&
                ["bar", "quantity", "price"].every(
                  (key) =>
                    typeof fill[key] === "number" && Number.isFinite(fill[key]),
                ) &&
                (fill.pnl === null ||
                  (typeof fill.pnl === "number" && Number.isFinite(fill.pnl))),
            ))),
    ) ||
    !Array.isArray(value.events) ||
    value.events.length > 50 ||
    !value.events.every(
      /** Audit content remains React text; no HTML parsing or event execution. */ (
        event,
      ) =>
        record(event) &&
        Number.isSafeInteger(event.id) &&
        typeof event.message === "string" &&
        typeof event.created_at === "string",
    )
  ) {
    throw new Error(
      "Workspace response is incomplete. Refresh or check the server.",
    );
  }
  return value as unknown as WorkspaceSnapshot;
}
/** Validate public setup policy without inferring account/trading permissions from missing fields. */
function parseAuthStatus(value: unknown): AuthStatus {
  if (
    !record(value) ||
    ![
      "setup_required",
      "setup_token_required",
      "registration_enabled",
      "invite_required",
    ].every(
      /** Every displayed setup choice must come from a valid server boolean. */ (
        key,
      ) => typeof value[key] === "boolean",
    )
  ) {
    throw new Error("Sign-in policy is unavailable.");
  }
  return value as unknown as AuthStatus;
}
