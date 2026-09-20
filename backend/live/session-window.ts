/** Stop new exposure before expiry, leaving time for cancellation and reconciliation.
 * This guard must not be applied to cancellation requests themselves. All times are ms. */
export const LIVE_SESSION_BUFFER_MS = 30_000;

/** Bound a live permission to both sessions and fail closed on invalid or expiring clocks. */
export function livePermissionDeadline(
  appExpiresAt: number,
  brokerExpiresAt: number,
  now = Date.now(),
): number {
  if (![appExpiresAt, brokerExpiresAt, now].every(Number.isSafeInteger)) {
    throw new Error("Invalid live session expiry");
  }
  const deadline = Math.min(
    now + 5 * 60_000,
    appExpiresAt - LIVE_SESSION_BUFFER_MS,
    brokerExpiresAt - LIVE_SESSION_BUFFER_MS,
  );
  if (deadline <= now) {
    throw Object.assign(
      new Error(
        "Session expires soon. Reconnect and arm live execution again.",
      ),
      { status: 409 },
    );
  }
  return deadline;
}
