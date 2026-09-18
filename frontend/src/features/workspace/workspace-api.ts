/** Validate snapshots at the browser boundary; TypeScript assertions alone do not validate JSON. */
import type { AuthStatus, WorkspaceSnapshot } from "./workspace-types";

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
export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
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
export function parseAuthStatus(value: unknown): AuthStatus {
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
