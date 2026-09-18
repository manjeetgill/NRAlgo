/** Kotak data-only REST adapter. Fixed broker hosts/paths, no order endpoint or arbitrary URL.
 * TOTP/MPIN are used once and not persisted. Tokens live only in a session-bound memory registry.
 * Reference: Kotak-Neo/Kotak-Neo docs/authentication.md and market-data-apis/quotes.md.
 */
import { z } from "zod";
import type { PaperQuote } from "./paper-model.js";
import { normalizePortfolioRows } from "./portfolio-model.js";
import { validateKotakMasterUrl } from "./instrument-master.js";
export const kotakLoginSchema = z
  .object({
    accessToken: z.string().trim().min(8).max(4096),
    mobileNumber: z.string().regex(/^\+91[0-9]{10}$/),
    ucc: z.string().trim().min(1).max(32),
    totp: z.string().regex(/^\d{6}$/),
    mpin: z.string().regex(/^\d{6}$/),
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
  }),
});
export type KotakTransport = (
  url: string,
  init: RequestInit,
) => Promise<unknown>;
/** Bound duration/body size and reject redirects so tokens cannot be forwarded to another host. */
export const kotakTransport: KotakTransport = async (url, init) => {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || !response.body) throw new Error("Kotak request failed.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 262144) throw new Error("Kotak response too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
/** Restrict broker-provided baseUrl to a verified origin: no paths, ports, credentials or lookalike domains. */
export function validateKotakOrigin(value: unknown) {
  if (value !== "https://cis.kotaksecurities.com")
    throw new Error(
      "Unsupported Kotak data host. Verify the official endpoint before enabling it.",
    );
  return value;
}
/** Convert documented decimal prices to paise without rounding invalid/missing values into a valid quote. */
function price(value: unknown) {
  if (
    !["string", "number"].includes(typeof value) ||
    String(value).trim() === ""
  )
    throw new Error("Missing price.");
  const n = Number(value) * 100;
  if (!Number.isFinite(n) || Math.abs(n - Math.round(n)) > 0.001)
    throw new Error("Invalid price.");
  return Math.round(n);
}
/** Match the requested exchange/token exactly and retain the exchange update epoch, not HTTP arrival. */
export function normalizeKotakQuote(
  raw: unknown,
  instrument: string,
  now = Date.now(),
  segment: "nse_cm" | "nse_fo" = "nse_cm",
): PaperQuote {
  if (!Array.isArray(raw) || raw.length !== 1)
    throw new Error("Missing or ambiguous Kotak quote.");
  const row = raw[0];
  if (row.exchange !== segment || String(row.exchange_token) !== instrument)
    throw new Error("Kotak instrument mismatch.");
  const observedAt = Number(row.lstup_time) * 1000;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0)
    throw new Error("Kotak timestamp missing.");
  return {
    instrument,
    bid: price(row.depth?.buy?.[0]?.price),
    ask: price(row.depth?.sell?.[0]?.price),
    observedAt,
    receivedAt: now,
  };
}
/** Per-owner, per-app-session connection. This class intentionally exposes quotes only after login. */
export class KotakDataManager {
  private sessions = new Map<
    string,
    {
      sessionHash: string;
      expires: number;
      accessToken: string;
      baseUrl: string;
      token: string;
      sid: string;
    }
  >();
  private pending = new Map<string, symbol>();
  private closed = false;
  /** Inject an offline transport only in tests; production uses bounded, TLS-verified fetch. */
  constructor(private transport: KotakTransport = kotakTransport) {}
  /** Authenticate once, reserving connection capacity before asynchronous network work begins. */
  async connect(
    userId: string,
    sessionHash: string,
    expires: number,
    input: KotakLogin,
  ) {
    if (this.closed) throw new Error("Kotak data manager closed.");
    if (this.pending.has(userId))
      throw new Error("Kotak login already in progress.");
    this.disconnect(userId);
    for (const [id, value] of this.sessions)
      if (value.expires < Date.now()) this.sessions.delete(id);
    if (this.sessions.size + this.pending.size >= 3)
      throw new Error("Kotak connection capacity reached.");
    const generation = Symbol("kotak-login");
    this.pending.set(userId, generation);
    const headers = {
      Authorization: input.accessToken,
      "neo-fin-key": "neotradeapi",
      "Content-Type": "application/json",
    };
    try {
      const first = loginResponse.parse(
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
      );
      if (
        first?.data?.status !== "success" ||
        first.data.kType !== "View" ||
        !first.data.token ||
        !first.data.sid
      )
        throw new Error();
      const second = loginResponse.parse(
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
      );
      if (
        second?.data?.status !== "success" ||
        second.data.kType !== "Trade" ||
        !second.data.token ||
        !second.data.sid
      )
        throw new Error();
      const baseUrl = validateKotakOrigin(second.data.baseUrl);
      if (this.closed || this.pending.get(userId) !== generation || expires <= Date.now())
        throw new Error("Login revoked during authentication.");
      this.sessions.set(userId, {
        sessionHash,
        expires: Math.min(expires, Date.now() + 8 * 3600000),
        accessToken: input.accessToken,
        baseUrl,
        token: second.data.token,
        sid: second.data.sid,
      });
    } catch {
      throw new Error(
        "Kotak login failed. Check token, TOTP, MPIN and supported host; no credentials were saved.",
      );
    } finally {
      if (this.pending.get(userId) === generation) this.pending.delete(userId);
    }
  }
  /** A second app session cannot borrow this session's token; expiry requires fresh login. */
  connected(userId: string, sessionHash: string) {
    const session = this.sessions.get(userId);
    if (session && session.expires < Date.now()) this.disconnect(userId);
    return Boolean(
      session &&
      session.expires >= Date.now() &&
      session.sessionHash === sessionHash,
    );
  }
  /** Read top-of-book for one cash token; upstream failure invalidates this in-memory connection. */
  async quote(
    userId: string,
    sessionHash: string,
    instrument: string,
    segment: "nse_cm" | "nse_fo" = "nse_cm",
  ) {
    if (!this.connected(userId, sessionHash))
      throw new Error("Connect Kotak in this app session first.");
    if (!/^\d{1,15}$/.test(instrument))
      throw new Error(
        "Use the NSE segment-specific pSymbol token from Kotak's instrument master.",
      );
    const session = this.sessions.get(userId)!;
    try {
      const raw = await this.transport(
        `${session.baseUrl}/script-details/1.0/quotes/neosymbol/${encodeURIComponent(`${segment}|${instrument}`)}/all`,
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
        !this.connected(userId, sessionHash)
      )
        throw new Error("Connection changed during quote request.");
      return normalizeKotakQuote(raw, instrument, Date.now(), segment);
    } catch {
      this.disconnect(userId);
      throw new Error(
        "Kotak data unavailable. Reconnect and verify the instrument; paper matching is paused.",
      );
    }
  }
  /** Discover only the requested segment's official master file; never expose the API token. */
  async instrumentMasterUrl(
    userId: string,
    sessionHash: string,
    market: "cash" | "options",
  ) {
    if (!this.connected(userId, sessionHash))
      throw new Error("Connect Kotak first.");
    const session = this.sessions.get(userId)!;
    try {
      const raw = (await this.transport(
        `${session.baseUrl}/script-details/1.0/masterscrip/file-paths`,
        { method: "GET", headers: { Authorization: session.accessToken } },
      )) as { data?: { filesPaths?: unknown[] } };
      if (
        this.sessions.get(userId) !== session ||
        !this.connected(userId, sessionHash) ||
        !Array.isArray(raw?.data?.filesPaths)
      )
        throw new Error();
      const suffix =
        market === "cash"
          ? "/transformed-v1/nse_cm-v1.csv"
          : "/transformed/nse_fo.csv";
      const paths = raw.data.filesPaths.filter(
        (path) => typeof path === "string" && path.endsWith(suffix),
      );
      if (paths.length !== 1) throw new Error();
      return validateKotakMasterUrl(paths[0], market);
    } catch {
      throw new Error(
        "Kotak instrument discovery unavailable. Verify your connection.",
      );
    }
  }
  /** Portfolio uses the session Auth/Sid headers, unlike the access-token-only quote endpoint. */
  async portfolio(
    userId: string,
    sessionHash: string,
    kind: "positions" | "holdings",
  ) {
    if (!this.connected(userId, sessionHash))
      throw new Error("Connect Kotak first.");
    const session = this.sessions.get(userId)!;
    try {
      const raw = (await this.transport(
        `${session.baseUrl}${kind === "positions" ? "/quick/user/positions" : "/portfolio/v1/holdings"}`,
        {
          method: "GET",
          headers: {
            Auth: session.token,
            Sid: session.sid,
            "neo-fin-key": "neotradeapi",
            accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      )) as Record<string, unknown>;
      if (
        this.sessions.get(userId) !== session ||
        !this.connected(userId, sessionHash)
      )
        throw new Error();
      if (
        !raw ||
        (raw.stat !== undefined && raw.stat !== "Ok") ||
        raw.emsg ||
        (raw.stCode !== undefined && Number(raw.stCode) !== 200) ||
        (kind === "positions" && raw.stat !== "Ok")
      )
        throw new Error();
      return normalizePortfolioRows("kotak", kind, raw.data);
    } catch {
      throw new Error(
        "Kotak portfolio unavailable. Verify session and account; no empty portfolio assumed.",
      );
    }
  }
  /** Remove local token access without invoking any trading endpoint. */
  disconnect(userId: string) {
    this.sessions.delete(userId);
    this.pending.delete(userId);
  }
  /** Shutdown discards every in-memory token; the next process must authenticate explicitly. */
  close() {
    this.closed = true;
    this.sessions.clear();
    this.pending.clear();
  }
}
