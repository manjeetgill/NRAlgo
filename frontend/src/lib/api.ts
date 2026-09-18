/** Shared browser transport. Secrets stay on the same origin; mutations are never retried. */
const sessionExpiryListeners = new Set<() => void>();

/** One session owner clears every screen when the server explicitly rejects the app session.
 * An invalid MFA proof also uses HTTP 401, so status alone must not log the user out. */
export function subscribeSessionExpiry(listener: () => void): () => void {
  sessionExpiryListeners.add(listener);
  return () => {
    sessionExpiryListeners.delete(listener);
  };
}

/** Same-origin JSON request with bounded reads, structured errors and no automatic mutation retry. */
export async function requestApiJson(
  path: string,
  method = "GET",
  body?: unknown,
  csrf?: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid API path.");
  }
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    // Caller cancellation and the deadline cover both response headers and JSON consumption.
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => {
    throw new Error(
      "API response unavailable. Check the connection; verify order status before retrying.",
    );
  });
  if (!response.ok) {
    if (response.status === 401 && result?.code === "SESSION_EXPIRED") {
      for (const listener of sessionExpiryListeners) {
        listener();
      }
    }
    const detail =
      typeof result?.detail === "string" ? result.detail : "Request failed.";
    const correlationId =
      typeof result?.correlationId === "string" &&
      /^[a-f0-9-]{36}$/i.test(result.correlationId)
        ? result.correlationId
        : undefined;
    throw Object.assign(
      new Error(
        correlationId ? `${detail} Reference: ${correlationId}` : detail,
      ),
      {
        status: response.status,
        code: result?.code,
        correlationId,
        retryable: result?.retryable === true,
      },
    );
  }
  return result;
}
