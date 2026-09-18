/** Shared browser transport. Secrets stay on the same origin; mutations are never retried. */
export async function requestApiJson(
  path: string,
  method = "GET",
  body?: unknown,
  csrf?: string,
  timeoutMs = 15000,
) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid API path.");
  }
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
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
    const detail =
      typeof result?.detail === "string" ? result.detail : "Request failed.";
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return result;
}
