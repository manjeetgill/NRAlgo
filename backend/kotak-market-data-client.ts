/** Logs users into Kotak and reads their market data and portfolio.
 * A server-only session capability is consumed by the isolated live execution adapter.
 * TOTP/MPIN are used once and not persisted. Tokens live only in a session-bound memory registry.
 * Reference: Kotak-Neo/Kotak-Neo docs/authentication.md and market-data-apis/quotes.md.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import type { BrokerMarketDataReader } from "./broker-data-access.js";
import type { PaperQuote } from "./paper-trading-ledger.js";
import { normalizePortfolioRows } from "./broker-portfolio-normalizer.js";
import { validateKotakMasterUrl } from "./instrument-master.js";
import {
  marketRequestSchema,
  buildKotakMarketDataPath,
  parseKotakMarketDataResponse,
  kotakHistoryStatus,
  type MarketRequest,
} from "./kotak-market-data-contracts.js";
import {
  KotakMarketDataStream,
  feedRequestSchema,
  type FeedRequest,
  type FeedSocketFactory,
} from "./kotak-market-data-stream.js";
export const kotakLoginSchema = z
  .object({
    accessToken: z.string().trim().min(8).max(4096),
    mobileNumber: z
      .string()
      .trim()
      .regex(/^\+91[0-9]{10}$/),
    ucc: z.string().trim().min(1).max(32),
    totp: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
    mpin: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
  })
  .strict();
export type KotakLogin = z.infer<typeof kotakLoginSchema>;
const loginResponse = z.object({
  data: z.object({
    status: z.literal("success"),
    kType: z.enum(["View", "Trade"]),
    token: z.string().min(1).max(4096),
    sid: z.string().min(1).max(256),
    baseUrl: z.string().optional(),
    feedUrl: z.string().max(512).optional(),
  }),
});
export type KotakHttpRequest = (
  url: string,
  init: RequestInit,
  maxBytes?: number,
) => Promise<unknown>;
type LoginStage = "TOTP_LOGIN" | "MPIN_VERIFY" | "HOST_VALIDATION" | "SESSION";
/** Trusted diagnostics only: never retain broker bodies, credentials or original exception causes. */
export class KotakConnectionError extends Error {
  readonly status = 502;
  readonly detail: string;
  readonly code: string;
  constructor(stage: LoginStage, reason: string, guidance: string) {
    const code = `KOTAK_${stage}_${reason}`;
    super(
      `Kotak login failed [${code}]. ${guidance} Credentials were not saved.`,
    );
    this.code = code;
    this.detail = this.message;
  }
}
/** Internal transport classification contains no response text or request metadata. */
class KotakTransportError extends Error {
  constructor(
    public readonly category: string,
    public readonly brokerDetail = "",
  ) {
    super(category);
  }
}

/** Classify failures without retaining the original exception or its possibly sensitive body. */
function getLoginFailureReason(error: unknown, stage: LoginStage) {
  if (error instanceof KotakTransportError) {
    return error.category;
  }
  if (stage === "HOST_VALIDATION") {
    return "UNSUPPORTED_HOST";
  }
  if (stage === "SESSION") {
    return "REVOKED";
  }
  return "REQUEST_FAILED";
}

/** Give stage-specific recovery advice. A network failure is not proof of bad credentials;
 * a failed MPIN check is different from a failed first-step TOTP login.
 */
function getLoginRecoveryGuidance(stage: LoginStage, reason: string) {
  if (reason === "TIMEOUT" || reason === "NETWORK_ERROR") {
    return "The server could not complete the broker request. Check server connectivity; this does not prove the credentials are wrong.";
  }
  if (stage === "HOST_VALIDATION") {
    return "The returned data host is not approved. Verify it against official Kotak documentation before changing the allowlist.";
  }
  if (stage === "SESSION") {
    return "The app session expired or the connection was revoked. Sign in again.";
  }
  const credentialsRejected = ["REJECTED", "HTTP_401", "HTTP_403"].includes(
    reason,
  );
  if (credentialsRejected && stage === "TOTP_LOGIN") {
    return "Check the API dashboard token, +91 mobile number, UCC and a fresh registered TOTP. Broker access restrictions may also cause rejection.";
  }
  if (credentialsRejected) {
    return "Check the MPIN and API access. The first login stage completed, but verification failed.";
  }
  return "The broker request failed or returned an unexpected response. Use this stage code to investigate; do not repeatedly retry credentials.";
}
/** Extract bounded error fields only, never whole bodies, HTML, headers or success payloads.
 * Remove known request/response secrets before truncating so a cut-off token cannot leak.
 * Broker messages remain untrusted plain text; the UI renders them as React text, not HTML.
 */
function extractSafeBrokerErrorMessage(
  raw: unknown,
  secrets: string[] = [],
): string {
  const sensitiveValues = [...secrets];
  /** Collect known sensitive fields for redaction without logging or returning credential values. */
  function collectSensitiveResponseValues(value: unknown, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6) {
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        /token|secret|password|mpin|totp|authorization|sid|ucc|mobile|pan|email/i.test(
          key,
        ) &&
        typeof item === "string"
      ) {
        sensitiveValues.push(item);
      } else if (typeof item === "object") {
        collectSensitiveResponseValues(item, depth + 1);
      }
    }
  }
  collectSensitiveResponseValues(raw);
  /** Strip credentials and token-shaped values from public broker error diagnostics. */
  function redact(text: string) {
    for (const secret of sensitiveValues
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)) {
      for (const variant of new Set([
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret).slice(1, -1),
      ])) {
        text = text.split(variant).join("[redacted]");
      }
    }
    return text
      .replace(
        /\b(?:access[_-]?token|token|secret|password|mpin|totp|sid|authorization)\s*[:=]\s*["']?[^\s,;"']+/gi,
        "[credential redacted]",
      )
      .replace(/https?:\/\/[^\s"<>]+/gi, "[URL redacted]")
      .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9_.-]+/g, "[token redacted]")
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email redacted]")
      .replace(/\b\d{6,}\b/g, "[number redacted]")
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[token redacted]")
      .replace(/[<>\x00-\x1f\x7f]/g, " ")
      .slice(0, 400);
  }
  const messages: string[] = [];
  /** Traverse only bounded broker error fields; never expose the full response payload. */
  function collectBrokerErrorMessages(value: unknown, depth = 0) {
    if (
      !value ||
      typeof value !== "object" ||
      depth > 3 ||
      messages.length >= 3
    ) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 3)) {
        collectBrokerErrorMessages(item, depth + 1);
      }
      return;
    }
    const row = value as Record<string, unknown>;
    const message =
      row.message ??
      row.Message ??
      row.emsg ??
      row.error_description ??
      (typeof row.error === "string" ? row.error : undefined);
    const code = row.errorCode ?? row.code ?? row.Code ?? row.stCode;
    if (typeof message === "string") {
      const safeCode =
        typeof code === "string" || typeof code === "number"
          ? redact(String(code)).slice(0, 40)
          : "";
      messages.push(`${safeCode ? `[${safeCode}] ` : ""}${redact(message)}`);
    }
    for (const key of ["error", "errors", "data", "fault"]) {
      collectBrokerErrorMessages(row[key], depth + 1);
    }
  }
  collectBrokerErrorMessages(raw);
  return messages.slice(0, 3).join("; ").slice(0, 800);
}
/** Validate envelopes while carrying only redacted broker error fields into public diagnostics. */
function parseKotakLoginResponse(raw: unknown, secrets: string[]) {
  const rejected = z.object({ status: z.literal("error") });
  if (
    rejected.safeParse(raw).success ||
    z.object({ data: rejected }).safeParse(raw).success
  ) {
    throw new KotakTransportError(
      "REJECTED",
      extractSafeBrokerErrorMessage(raw, secrets),
    );
  }
  const parsed = loginResponse.safeParse(raw);
  if (!parsed.success) {
    throw new KotakTransportError(
      "UNEXPECTED_RESPONSE",
      extractSafeBrokerErrorMessage(raw, secrets),
    );
  }
  return parsed.data;
}
/** Bound duration/body size and reject redirects so tokens cannot be forwarded to another host. */
export const sendKotakHttpRequest: KotakHttpRequest = async (
  url,
  init,
  maxBytes = 262144,
) => {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    if (!response.body) {
      throw new KotakTransportError(
        response.ok ? "UNEXPECTED_RESPONSE" : `HTTP_${response.status}`,
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        length += value.length;
        if (length > Math.min(maxBytes, 4194304)) {
          throw new KotakTransportError("RESPONSE_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new KotakTransportError(
        response.ok ? "UNEXPECTED_RESPONSE" : `HTTP_${response.status}`,
      );
    }
    if (!response.ok) {
      const secrets = [...new Headers(init.headers).values()];
      if (typeof init.body === "string") {
        try {
          secrets.push(
            ...Object.values(JSON.parse(init.body)).filter(
              (value): value is string => typeof value === "string",
            ),
          );
        } catch {
          /* Never echo an unparseable request body. */
        }
      }
      throw new KotakTransportError(
        `HTTP_${response.status}`,
        extractSafeBrokerErrorMessage(raw, secrets),
      );
    }
    return raw;
  } catch (error) {
    if (error instanceof KotakTransportError) {
      throw error;
    }
    throw new KotakTransportError(
      error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
        ? "TIMEOUT"
        : "NETWORK_ERROR",
    );
  }
};
/** Accept only production data centers listed by Kotak's official SDK.
 * Authentication assigns a baseUrl per account; cis is an example, not the only host.
 * Sources: Kotak-Neo/kotak-neo-python neo_api_client/utils/urls.py and
 * docs/functions/authentication/totp_validate.md (verified 2026-09-18).
 * Match the complete string before normalization: URL parsing alone can hide path
 * traversal, credentials, whitespace or explicit ports. Only a final slash is harmless.
 * Never wildcard the broker domain or fall back to a different account's data center.
 */
export function validateKotakOrigin(value: unknown) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^https:\/\/(?:mis|cis|e21|e22|e41|e43)\.kotaksecurities\.com\/?$/.test(
      value,
    )
  ) {
    throw new Error(
      "Unsupported Kotak data host. Verify the official endpoint before enabling it.",
    );
  }
  return value.replace(/\/$/, "");
}
/** Only the documented /apifeed path on an approved broker data center may receive a SID.
 * An unfamiliar login-assigned feed host disables streaming, not REST account access.
 */
export function validateKotakFeedUrl(value: unknown) {
  // Official SDK default: docs/guides/websocket.md and utils/urls.py.
  if (value === null || value === undefined || value === "") {
    return "wss://sfeed.kotaksecurities.com/apifeed";
  }
  if (
    value === "https://sfeed.kotaksecurities.com/apifeed" ||
    value === "wss://sfeed.kotaksecurities.com/apifeed"
  ) {
    return "wss://sfeed.kotaksecurities.com/apifeed";
  }
  if (
    typeof value !== "string" ||
    !/^(https|wss):\/\/[^/]+\/apifeed$/.test(value)
  ) {
    throw new Error("Kotak did not return a supported feed URL.");
  }
  const origin = validateKotakOrigin(
    value.replace(/^wss:/, "https:").slice(0, -8),
  );
  return `${origin.replace("https:", "wss:")}/apifeed`;
}
/** Convert documented decimal prices to paise without rounding invalid/missing values into a valid quote. */
function convertRupeesToPaise(value: unknown) {
  if (
    !["string", "number"].includes(typeof value) ||
    String(value).trim() === ""
  ) {
    throw new Error("Missing price.");
  }
  const n = Number(value) * 100;
  if (!Number.isFinite(n) || Math.abs(n - Math.round(n)) > 0.001) {
    throw new Error("Invalid price.");
  }
  return Math.round(n);
}
/** Match the requested exchange/token exactly and retain the exchange update epoch, not HTTP arrival. */
export function parseKotakPaperFillQuote(
  raw: unknown,
  instrument: string,
  now = Date.now(),
  segment: "nse_cm" | "nse_fo" = "nse_cm",
): PaperQuote {
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new Error("Missing or ambiguous Kotak quote.");
  }
  const row = raw[0];
  if (row.exchange !== segment || String(row.exchange_token) !== instrument) {
    throw new Error("Kotak instrument mismatch.");
  }
  const observedAt = Number(row.lstup_time) * 1000;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) {
    throw new Error("Kotak timestamp missing.");
  }
  return {
    instrument,
    bid: convertRupeesToPaise(row.depth?.buy?.[0]?.price),
    ask: convertRupeesToPaise(row.depth?.sell?.[0]?.price),
    observedAt,
    receivedAt: now,
  };
}
/** Per-owner, per-app-session connection. This class intentionally exposes quotes only after login. */
export class KotakMarketDataClient implements BrokerMarketDataReader {
  private sessions = new Map<
    string,
    {
      sessionHash: string;
      expires: number;
      accessToken: string;
      baseUrl: string;
      token: string;
      sid: string;
      ucc: string;
      feedUrl?: string;
    }
  >();
  private pending = new Map<string, symbol>();
  private closed = false;
  private feeds = new Map<string, KotakMarketDataStream>();
  /** Inject an offline transport only in tests; production uses bounded, TLS-verified fetch. */
  constructor(
    private transport: KotakHttpRequest = sendKotakHttpRequest,
    private socketFactory?: FeedSocketFactory,
  ) {}
  /** Authenticate once, reserving connection capacity before asynchronous network work begins. */
  public async connect(
    userId: string,
    sessionHash: string,
    expires: number,
    input: KotakLogin,
  ) {
    if (this.closed) {
      throw new KotakConnectionError(
        "SESSION",
        "CLOSED",
        "The connection service is shutting down.",
      );
    }
    if (this.pending.has(userId)) {
      throw new KotakConnectionError(
        "SESSION",
        "IN_PROGRESS",
        "Wait for the existing login attempt to finish.",
      );
    }
    this.disconnect(userId);
    for (const [id, value] of this.sessions) {
      if (value.expires < Date.now()) {
        this.disconnect(id);
      }
    }
    if (this.sessions.size + this.pending.size >= 3) {
      throw new KotakConnectionError(
        "SESSION",
        "CAPACITY",
        "The server connection limit has been reached.",
      );
    }
    const generation = Symbol("kotak-login");
    this.pending.set(userId, generation);
    const headers = {
      Authorization: input.accessToken,
      "neo-fin-key": "neotradeapi",
      "Content-Type": "application/json",
    };
    let stage: LoginStage = "TOTP_LOGIN";
    try {
      const first = parseKotakLoginResponse(
        await this.transport(
          "https://mis.kotaksecurities.com/login/1.0/tradeApiLogin",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              mobileNumber: input.mobileNumber,
              ucc: input.ucc,
              totp: input.totp,
            }),
          },
        ),
        Object.values(input),
      );
      if (
        first?.data?.status !== "success" ||
        first.data.kType !== "View" ||
        !first.data.token ||
        !first.data.sid
      ) {
        throw new KotakTransportError("UNEXPECTED_RESPONSE");
      }
      stage = "MPIN_VERIFY";
      const second = parseKotakLoginResponse(
        await this.transport(
          "https://mis.kotaksecurities.com/login/1.0/tradeApiValidate",
          {
            method: "POST",
            headers: {
              ...headers,
              sid: first.data.sid,
              Auth: first.data.token,
            },
            body: JSON.stringify({ mpin: input.mpin }),
          },
        ),
        [...Object.values(input), first.data.token, first.data.sid],
      );
      if (
        second?.data?.status !== "success" ||
        second.data.kType !== "Trade" ||
        !second.data.token ||
        !second.data.sid
      ) {
        throw new KotakTransportError("UNEXPECTED_RESPONSE");
      }
      stage = "HOST_VALIDATION";
      const baseUrl = validateKotakOrigin(second.data.baseUrl);
      stage = "SESSION";
      if (
        this.closed ||
        this.pending.get(userId) !== generation ||
        expires <= Date.now()
      ) {
        throw new Error("Login revoked during authentication.");
      }
      this.sessions.set(userId, {
        sessionHash,
        expires: Math.min(expires, Date.now() + 8 * 3600000),
        accessToken: input.accessToken,
        baseUrl,
        token: second.data.token,
        sid: second.data.sid,
        ucc: input.ucc,
        feedUrl: second.data.feedUrl,
      });
    } catch (error) {
      const reason = getLoginFailureReason(error, stage);
      const guidance = getLoginRecoveryGuidance(stage, reason);
      // Redact against all login inputs again: the first HTTP request does not contain MPIN.
      const brokerDetail =
        error instanceof KotakTransportError && error.brokerDetail
          ? extractSafeBrokerErrorMessage(
              { message: error.brokerDetail },
              Object.values(input),
            )
          : "";
      throw new KotakConnectionError(
        stage,
        reason,
        `${brokerDetail ? `Broker response: ${brokerDetail}. ` : ""}${guidance}`,
      );
    } finally {
      if (this.pending.get(userId) === generation) {
        this.pending.delete(userId);
      }
    }
  }
  /** A second app session cannot borrow this session's token; expiry requires fresh login. */
  public isConnected(userId: string, sessionHash: string) {
    const session = this.sessions.get(userId);
    if (session && session.expires < Date.now()) {
      this.disconnect(userId);
    }
    return Boolean(
      session &&
      session.expires >= Date.now() &&
      session.sessionHash === sessionHash,
    );
  }
  /** Server-only capability; credentials never leave this closure. No HTTP route accepts
   * arbitrary paths. Capturing the exact session object fences reconnects and revocations. */
  public executionSession(userId: string, sessionHash: string) {
    if (!this.isConnected(userId, sessionHash)) {
      throw new Error("Connect Kotak first");
    }
    const session = this.sessions.get(userId)!;
    const isCurrent = () =>
      this.sessions.get(userId) === session &&
      this.isConnected(userId, sessionHash);
    return {
      accountBinding: `kotak:${createHash("sha256").update(session.ucc.trim().toUpperCase()).digest("hex")}`,
      isCurrent,
      request: async (
        path: string,
        body: Record<string, string> | undefined,
        signal: AbortSignal,
      ) => {
        const reads = [
          "/quick/user/orders",
          "/quick/user/positions",
          "/quick/user/limits",
        ];
        const writes = ["/quick/order/rule/ms/place", "/quick/order/cancel"];
        if (
          !isCurrent() ||
          signal.aborted ||
          ![...reads, ...writes].includes(path)
        ) {
          throw new Error("Live broker session unavailable");
        }
        if (
          (path === "/quick/user/limits" || writes.includes(path)) !==
          Boolean(body)
        ) {
          throw new Error("Invalid broker request");
        }
        const result = await this.transport(`${session.baseUrl}${path}`, {
          method: body ? "POST" : "GET",
          signal,
          headers: {
            Auth: session.token,
            Sid: session.sid,
            Authorization: session.accessToken,
            "Content-Type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          ...(body
            ? {
                body: new URLSearchParams({
                  jData: JSON.stringify(body),
                }).toString(),
              }
            : {}),
        });
        if (!isCurrent() || signal.aborted) {
          throw new Error("Live broker session changed");
        }
        return result;
      },
    };
  }
  /** One bounded snapshot request for server-resolved NFO contracts. Missing fields stay null;
   * never use a display snapshot as a paper fill or substitute another contract's price.
   * Kotak documents up to 50 instruments per quotes request in its current SDK.
   */
  public async getQuoteSnapshots(
    userId: string,
    sessionHash: string,
    instruments: string[],
    segment: "nse_cm" | "nse_fo" = "nse_fo",
  ) {
    if (!this.isConnected(userId, sessionHash)) {
      throw new Error("Connect Kotak first.");
    }
    if (
      !instruments.length ||
      instruments.length > 50 ||
      new Set(instruments).size !== instruments.length ||
      instruments.some((token) => !/^\d{1,15}$/.test(token))
    ) {
      throw new Error("Invalid option quote batch.");
    }
    const session = this.sessions.get(userId)!;
    const raw = await this.transport(
      `${session.baseUrl}/script-details/1.0/quotes/neosymbol/${encodeURIComponent(instruments.map((token) => `${segment}|${token}`).join(","))}/all`,
      { method: "GET", headers: { Authorization: session.accessToken } },
    );
    if (
      this.sessions.get(userId) !== session ||
      !this.isConnected(userId, sessionHash)
    ) {
      throw new Error("Kotak session changed during quote fetch.");
    }
    if (!Array.isArray(raw) || raw.length > instruments.length) {
      throw new Error("Unexpected option quote response.");
    }
    const quoteRow = z.object({
      exchange: z.string(),
      exchange_token: z.union([z.string(), z.number()]),
      ltp: z.unknown().optional(),
      lstup_time: z.unknown().optional(),
      open_int: z.unknown().optional(),
      last_volume: z.unknown().optional(),
      depth: z
        .object({
          buy: z.array(z.object({ price: z.unknown().optional() })).optional(),
          sell: z.array(z.object({ price: z.unknown().optional() })).optional(),
        })
        .optional(),
    });
    const rows = new Map<string, z.infer<typeof quoteRow>>();
    for (const row of raw) {
      if (
        !row ||
        row.exchange !== segment ||
        !instruments.includes(String(row.exchange_token)) ||
        rows.has(String(row.exchange_token))
      ) {
        throw new Error("Option quote identity mismatch.");
      }
      rows.set(String(row.exchange_token), quoteRow.parse(row));
    }
    const number = (value: unknown) => {
      if (
        (typeof value !== "number" && typeof value !== "string") ||
        String(value).trim() === ""
      ) {
        return null;
      }
      const result = Number(value);
      return Number.isFinite(result) && result >= 0 ? result : null;
    };
    return instruments.map((instrument) => {
      const row = rows.get(instrument);
      const seconds = number(row?.lstup_time),
        observedAt = seconds === null ? null : seconds * 1000;
      return {
        instrument,
        price: number(row?.ltp),
        bid: number(row?.depth?.buy?.[0]?.price),
        ask: number(row?.depth?.sell?.[0]?.price),
        openInterest: number(row?.open_int),
        volume: number(row?.last_volume),
        observedAt,
        stale:
          number(row?.ltp) === null ||
          observedAt === null ||
          observedAt > Date.now() + 5000 ||
          Date.now() - observedAt > 15000,
      };
    });
  }
  /** Fetch one day of real candles using documented lowercase wire parameters.
   * Convert positional ISO rows to our research candle input; no synthetic bars or token fallback.
   */
  public async getHistoricalCandlesForDay(
    userId: string,
    sessionHash: string,
    token: string,
    segment: "nse_cm" | "nse_fo",
    day: string,
    interval: "1minute" | "5minute",
  ) {
    if (!this.isConnected(userId, sessionHash)) {
      throw new Error("Connect Kotak first.");
    }
    if (
      !/^\d{1,15}$/.test(token) ||
      !z.iso.date().safeParse(day).success ||
      !["1minute", "5minute"].includes(interval)
    ) {
      throw new Error("Invalid historical query.");
    }
    const session = this.sessions.get(userId)!;
    const query = new URLSearchParams({
      neosymbol: `${segment}|${token}`,
      interval: interval === "1minute" ? "1min" : "5min",
      fromdate: day,
      todate: day,
    });
    const raw = await this.transport(
      `${session.baseUrl}/market-data/1.0/historical/details?${query}`,
      {
        method: "GET",
        headers: {
          Authorization: session.accessToken,
          "Content-Type": "application/json",
        },
      },
    );
    if (
      this.sessions.get(userId) !== session ||
      !this.isConnected(userId, sessionHash)
    ) {
      throw new Error("Kotak session changed during history fetch.");
    }
    const parsed = z
      .object({
        status: kotakHistoryStatus,
        interval: z
          .literal(interval === "1minute" ? "1min" : "5min")
          .optional(),
        data: z.object({
          candles: z.array(z.array(z.unknown()).min(5).max(7)).min(2).max(999),
        }),
      })
      .safeParse(raw);
    if (!parsed.success) {
      throw new Error("Kotak history unavailable or malformed.");
    }
    return parsed.data.data.candles.map((row) => {
      if (
        typeof row[0] !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(
          row[0],
        )
      ) {
        throw new Error("Invalid Kotak candle timestamp.");
      }
      return {
        datetime: row[0].replace(/([+-]\d{2})(\d{2})$/, "$1:$2"),
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
      };
    });
  }
  /** Read executable top-of-book separately from research data. */
  public async getPaperFillQuote(
    userId: string,
    sessionHash: string,
    instrument: string,
    segment: "nse_cm" | "nse_fo" = "nse_cm",
    signal?: AbortSignal,
  ) {
    if (!this.isConnected(userId, sessionHash)) {
      throw new Error("Connect Kotak in this app session first.");
    }
    if (!/^\d{1,15}$/.test(instrument)) {
      throw new Error(
        "Use the NSE segment-specific pSymbol token from Kotak's instrument master.",
      );
    }
    const session = this.sessions.get(userId)!;
    try {
      const raw = await this.transport(
        `${session.baseUrl}/script-details/1.0/quotes/neosymbol/${encodeURIComponent(`${segment}|${instrument}`)}/all`,
        {
          method: "GET",
          signal,
          headers: {
            Authorization: session.accessToken,
            "Content-Type": "application/json",
          },
        },
      );
      if (
        this.sessions.get(userId) !== session ||
        !this.isConnected(userId, sessionHash)
      ) {
        throw new Error("Connection changed during quote request.");
      }
      return parseKotakPaperFillQuote(raw, instrument, Date.now(), segment);
    } catch {
      // A delayed failure belongs to its captured session, never a newer login.
      if (this.sessions.get(userId) === session) {
        this.disconnect(userId);
      }
      throw new Error(
        "Kotak data unavailable. Reconnect and verify the instrument; paper matching is paused.",
      );
    }
  }
  /** Discover only the requested segment's official master file; never expose the API token. */
  public async getInstrumentMasterUrl(
    userId: string,
    sessionHash: string,
    market: "cash" | "options",
  ) {
    if (!this.isConnected(userId, sessionHash)) {
      throw new Error("Connect Kotak first.");
    }
    const session = this.sessions.get(userId)!;
    try {
      const raw = (await this.transport(
        `${session.baseUrl}/script-details/1.0/masterscrip/file-paths`,
        { method: "GET", headers: { Authorization: session.accessToken } },
      )) as { data?: { filesPaths?: unknown[] } };
      if (
        this.sessions.get(userId) !== session ||
        !this.isConnected(userId, sessionHash) ||
        !Array.isArray(raw?.data?.filesPaths)
      ) {
        throw new Error();
      }
      const suffix =
        market === "cash"
          ? "/transformed-v1/nse_cm-v1.csv"
          : "/transformed/nse_fo.csv";
      const paths = raw.data.filesPaths.filter(
        (path) => typeof path === "string" && path.endsWith(suffix),
      );
      if (paths.length !== 1) {
        throw new Error();
      }
      return validateKotakMasterUrl(paths[0], market);
    } catch {
      throw new Error(
        "Kotak instrument discovery unavailable. Verify your connection.",
      );
    }
  }
  /** Portfolio uses the session Auth/Sid headers, unlike the access-token-only quote endpoint. */
  public async getPortfolioRows(
    userId: string,
    sessionHash: string,
    kind: "positions" | "holdings",
  ) {
    if (!this.isConnected(userId, sessionHash)) {
      throw new Error("Connect Kotak first.");
    }
    const session = this.sessions.get(userId)!;
    try {
      const raw = (await this.transport(
        `${session.baseUrl}${kind === "positions" ? "/quick/user/positions" : "/portfolio/v1/holdings"}`,
        {
          method: "GET",
          headers: {
            Auth: session.token,
            Sid: session.sid,
            accept: "application/json",
          },
        },
      )) as Record<string, unknown>;
      if (
        this.sessions.get(userId) !== session ||
        !this.isConnected(userId, sessionHash)
      ) {
        throw new Error();
      }
      const nested =
        raw && typeof raw.data === "object" && !Array.isArray(raw.data)
          ? (raw.data as Record<string, unknown>)
          : null;
      const status = raw?.stat ?? nested?.stat;
      const statusCode = raw?.stCode ?? nested?.stCode;
      const brokerError = raw?.emsg ?? nested?.emsg;
      const rows = Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(nested?.data)
          ? nested.data
          : Array.isArray(nested?.positions)
            ? nested.positions
            : Array.isArray(raw?.positions)
              ? raw.positions
              : null;
      if (
        !raw ||
        (status !== undefined && String(status).toLowerCase() !== "ok") ||
        brokerError ||
        (statusCode !== undefined && Number(statusCode) !== 200) ||
        !rows
      ) {
        throw new Error();
      }
      return normalizePortfolioRows(kind, rows);
    } catch {
      throw new Error(
        "Kotak portfolio unavailable. Verify session and account; no empty portfolio assumed.",
      );
    }
  }
  /** Read-only broker reports. Limits uses a documented POST query, never an order endpoint.
   * Return selected public account fields only; unknown payloads are not empty accounts.
   */
  public async getAccountReport(
    userId: string,
    sessionHash: string,
    kind: "limits" | "orders" | "trades",
  ) {
    if (!this.isConnected(userId, sessionHash)) {
      throw new Error("Connect Kotak first.");
    }
    if (!["limits", "orders", "trades"].includes(kind)) {
      throw new Error("Unsupported report.");
    }
    const session = this.sessions.get(userId)!;
    const raw = await this.transport(`${session.baseUrl}/quick/user/${kind}`, {
      method: kind === "limits" ? "POST" : "GET",
      headers: {
        Auth: session.token,
        Sid: session.sid,
        accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      ...(kind === "limits"
        ? {
            body: new URLSearchParams({
              jData: JSON.stringify({ seg: "ALL", exch: "ALL", prod: "ALL" }),
            }).toString(),
          }
        : {}),
    });
    if (
      this.sessions.get(userId) !== session ||
      !this.isConnected(userId, sessionHash)
    ) {
      throw new Error("Kotak session changed during report fetch.");
    }
    const envelope = z
      .object({ stat: z.enum(["Ok", "ok"]), stCode: z.number().optional() })
      .passthrough()
      .safeParse(raw);
    if (
      !envelope.success ||
      (envelope.data.stCode !== undefined && envelope.data.stCode !== 200)
    ) {
      throw new Error("Kotak report unavailable.");
    }
    const numeric = (value: unknown) =>
      (typeof value === "number" ||
        (typeof value === "string" && value.trim() !== "")) &&
      Number.isFinite(Number(value))
        ? Number(value)
        : null;
    const text = (value: unknown) =>
      typeof value === "string" || typeof value === "number"
        ? String(value).slice(0, 100)
        : "";
    if (kind === "limits") {
      return [
        {
          available: numeric(envelope.data.Net),
          marginUsed: numeric(envelope.data.MarginUsed),
          collateral: numeric(envelope.data.CollateralValue),
          realizedPnl: numeric(envelope.data.RealizedMtomPrsnt),
          unrealizedPnl: numeric(envelope.data.UnrealizedMtomPrsnt),
        },
      ];
    }
    const rows = z
      .array(z.record(z.string(), z.unknown()))
      .max(5000)
      .parse(envelope.data.data);
    return rows.map((row) => ({
      orderId: text(row.nOrdNo),
      symbol: text(row.trdSym),
      exchange: text(row.exSeg),
      side: text(row.trnsTp),
      status: kind === "orders" ? text(row.ordSt ?? row.stat) : "fill",
      quantity: numeric(kind === "orders" ? row.qty : row.fldQty),
      price: numeric(kind === "orders" ? row.prc : row.avgPrc),
      filledQuantity: numeric(row.fldQty),
      time: text(kind === "orders" ? row.ordDtTm : row.flTm),
    }));
  }
  /** Execute one explorer read, fenced to the current session. Larger history responses get
   * an explicit 4 MiB ceiling, never an unbounded download. Sanitized errors do not echo tokens.
   */
  public async fetchMarketData(
    userId: string,
    sessionHash: string,
    request: MarketRequest,
    signal?: AbortSignal,
  ) {
    const input = marketRequestSchema.parse(request);
    if (!this.isConnected(userId, sessionHash)) {
      throw Object.assign(new Error(), {
        status: 409,
        detail: "Connect Kotak in this app session first.",
      });
    }
    const session = this.sessions.get(userId)!;
    let historyShape = "";
    try {
      const raw = await this.transport(
        `${session.baseUrl}${buildKotakMarketDataPath(input)}`,
        {
          method: "GET",
          signal,
          headers: {
            Authorization: session.accessToken,
            "Content-Type": "application/json",
          },
        },
        input.operation === "history" ? 4194304 : 262144,
      );
      if (
        signal?.aborted ||
        this.sessions.get(userId) !== session ||
        !this.isConnected(userId, sessionHash)
      ) {
        throw new Error("Session changed.");
      }
      const envelope = raw as Record<string, unknown> | null;
      if (input.operation === "history" && envelope) {
        // Diagnostics describe only an allowlisted status and candle-container shape.
        // Never return arbitrary broker strings, response bodies or session identifiers.
        const status = envelope.status;
        const normalized =
          typeof status === "string" ? status.trim().toLowerCase() : status;
        const known = [
          "success",
          "ok",
          "error",
          "failed",
          "failure",
          "not_ok",
          "200",
          "400",
          "401",
          "403",
          "500",
          200,
          400,
          401,
          403,
          500,
          0,
          1,
          true,
          false,
        ];
        const statusKind = known.includes(
          normalized as string | number | boolean,
        )
          ? `${typeof status}:${String(normalized)}`
          : status === null
            ? "null"
            : typeof status;
        const data = envelope.data;
        const candles =
          data && typeof data === "object"
            ? (data as Record<string, unknown>).candles
            : undefined;
        historyShape = ` History shape: status=${statusKind}, candles=${Array.isArray(candles) ? "array" : typeof candles}.`;
      }
      if (
        envelope &&
        (envelope.stat === "Not_Ok" || envelope.status === "ERROR")
      ) {
        throw new KotakTransportError(
          "BROKER_REJECTED",
          extractSafeBrokerErrorMessage(raw, [
            session.accessToken,
            session.token,
            session.sid,
            session.ucc,
          ]),
        );
      }
      return parseKotakMarketDataResponse(input, raw);
    } catch (error) {
      if (
        this.sessions.get(userId) === session &&
        error instanceof KotakTransportError &&
        ["HTTP_401", "HTTP_403"].includes(error.category)
      ) {
        this.disconnect(userId);
      }
      const reason =
        error instanceof KotakTransportError
          ? error.category
          : error instanceof z.ZodError
            ? `INVALID_RESPONSE:${error.issues
                .slice(0, 3)
                .map(
                  (issue) =>
                    `${issue.path.filter((part) => typeof part === "number" || ["status", "interval", "data", "candles"].includes(String(part))).join(".")}:${issue.code}`,
                )
                .join(",")}`
            : error instanceof Error &&
                [
                  "Invalid candle time.",
                  "Unordered or invalid candles.",
                  "Invalid candle range or values.",
                ].includes(error.message)
              ? `INVALID_RESPONSE:${error.message}`
              : "INVALID_RESPONSE";
      const brokerDetail =
        error instanceof KotakTransportError && error.brokerDetail
          ? extractSafeBrokerErrorMessage({ message: error.brokerDetail }, [
              session.accessToken,
              session.token,
              session.sid,
              session.ucc,
            ])
          : "";
      throw Object.assign(new Error(), {
        status: 502,
        detail: `Kotak market data unavailable [${reason}].${historyShape} ${brokerDetail ? `Broker: ${brokerDetail}. ` : ""}Check connection, instrument and data access; for large history requests, shorten the date range.`,
      });
    }
  }

  /** Start a fresh session-owned feed. Endpoint/credentials are never returned to the browser. */
  public startMarketDataStream(
    userId: string,
    sessionHash: string,
    request: FeedRequest,
  ) {
    const input = feedRequestSchema.parse(request);
    if (!this.isConnected(userId, sessionHash)) {
      throw Object.assign(new Error(), {
        status: 409,
        detail: "Connect Kotak first.",
      });
    }
    const session = this.sessions.get(userId)!;
    const existing = this.feeds.get(userId)?.getLatestSnapshot();
    if (
      existing &&
      ["connecting", "subscription-requested"].includes(existing.state) &&
      input.kind === "touchline" &&
      existing.kind === input.kind &&
      existing.mode === input.mode &&
      input.mode === "subscribe" &&
      input.instruments.every((item) =>
        existing.instruments.some(
          (row) =>
            row.exchange === item.exchange &&
            row.instrument === item.instrument,
        ),
      )
    ) {
      return existing;
    }
    let url: string;
    try {
      url = validateKotakFeedUrl(session.feedUrl);
    } catch {
      throw Object.assign(new Error(), {
        status: 409,
        detail:
          "Kotak did not return an approved feedUrl. Reconnect; an unfamiliar host needs verification against official documentation. REST data remains available.",
      });
    }
    this.stopMarketDataStream(userId, sessionHash);
    const feed = new KotakMarketDataStream(
      url,
      session.ucc,
      session.sid,
      input,
      () =>
        this.sessions.get(userId) === session &&
        this.isConnected(userId, sessionHash),
      this.socketFactory,
    );
    this.feeds.set(userId, feed);
    return feed.getLatestSnapshot();
  }

  /** Read only the current browser session's cache, never another session's subscription. */
  public getMarketDataStreamSnapshot(userId: string, sessionHash: string) {
    if (!this.isConnected(userId, sessionHash)) {
      throw Object.assign(new Error(), {
        status: 409,
        detail: "Connect Kotak first.",
      });
    }
    return (
      this.feeds.get(userId)?.getLatestSnapshot() ?? {
        state: "stopped",
        records: [],
        notifications: [],
      }
    );
  }

  /** Bounded control operations reuse the immutable subscription set; no order messages exist. */
  public sendMarketDataStreamCommand(
    userId: string,
    sessionHash: string,
    action: "subscribe" | "unsubscribe" | "snapshot",
  ) {
    if (!this.isConnected(userId, sessionHash) || !this.feeds.has(userId)) {
      throw Object.assign(new Error(), {
        status: 409,
        detail: "Start the feed first.",
      });
    }
    try {
      this.feeds.get(userId)!.sendSubscriptionCommand(action);
    } catch {
      throw Object.assign(new Error(), {
        status: 409,
        detail: "Feed not ready. Reconnect after a feed error.",
      });
    }
    return this.getMarketDataStreamSnapshot(userId, sessionHash);
  }

  /** Closing a feed is always local and does not consume a broker REST budget. */
  public stopMarketDataStream(userId: string, sessionHash: string) {
    if (this.sessions.get(userId)?.sessionHash !== sessionHash) {
      return;
    }
    this.feeds.get(userId)?.closeConnection();
    this.feeds.delete(userId);
  }

  /** Remove local token access without invoking any trading endpoint. */
  public disconnect(userId: string) {
    this.feeds.get(userId)?.closeConnection();
    this.feeds.delete(userId);
    this.sessions.delete(userId);
    this.pending.delete(userId);
  }
  /** Shutdown discards every in-memory token; the next process must authenticate explicitly. */
  public close() {
    this.closed = true;
    for (const feed of this.feeds.values()) {
      feed.closeConnection();
    }
    this.feeds.clear();
    this.sessions.clear();
    this.pending.clear();
  }
}
