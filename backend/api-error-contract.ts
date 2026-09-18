/** Public error envelope and server-generated correlation identity for every JSON failure.
 * `retryable` describes service recovery, never permission to blindly repeat an execution command. */
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const ERROR_CODES: Record<number, string> = {
  400: "INVALID_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  410: "CAPABILITY_RETIRED",
  413: "REQUEST_TOO_LARGE",
  422: "VALIDATION_FAILED",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "PROVIDER_UNAVAILABLE",
  503: "SERVICE_UNAVAILABLE",
};

/** Wrap intentionally public JSON errors, retaining `detail` for existing clients and tests.
 * Never accept a caller's correlation header or serialize raw exception objects/validation input. */
export const apiErrorContract: RequestHandler = (_req, res, next) => {
  const correlationId = randomUUID();
  res.locals.correlationId = correlationId;
  res.setHeader("X-Correlation-ID", correlationId);
  const sendJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 400) {
      return sendJson(body);
    }
    const original =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message =
      typeof original.detail === "string" ? original.detail : "Request failed.";
    return sendJson({
      ...original,
      detail: message,
      message,
      code:
        original.code === "SESSION_EXPIRED"
          ? "SESSION_EXPIRED"
          : (ERROR_CODES[res.statusCode] ?? "REQUEST_FAILED"),
      retryable: res.statusCode === 429 || res.statusCode >= 500,
      correlationId,
    });
  };
  next();
};
