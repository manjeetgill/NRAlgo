/** Read-only categorization of legacy text audit records; categories are derived, not server assertions. */
export const AUDIT_CATEGORIES = [
  "All",
  "Trading",
  "Broker",
  "Security",
  "Market",
  "Workspace",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export interface AuditEvent {
  id: number;
  message: string;
  created_at: string;
}

/** Deduplicate immutable IDs, then order by server occurrence time with an ID tie-break.
 * Invalid timestamps sort last; duplicate delivery cannot multiply Overview or Audit rows. */
export function orderAuditEvents(events: AuditEvent[]): AuditEvent[] {
  const unique = new Map<number, AuditEvent>();
  for (const event of events) {
    if (!unique.has(event.id)) {
      unique.set(event.id, event);
    }
  }
  /** Treat malformed timestamps as unknown, not browser arrival time. */
  function timestamp(event: AuditEvent) {
    const value = Date.parse(event.created_at);
    return Number.isFinite(value) ? value : -Infinity;
  }
  return [...unique.values()].sort(
    /** Keep stable order even when event timestamps are identical. */ (
      a,
      b,
    ) =>
      timestamp(a) === timestamp(b)
        ? b.id - a.id
        : timestamp(a) > timestamp(b)
          ? -1
          : 1,
  );
}

/** Prefer security and execution context before broker names appearing in an order message. */
export function categorizeAuditEvent(
  message: string,
): Exclude<AuditCategory, "All"> {
  if (
    /\b(password|mfa|authenticator|recovery|sign.in|sign.out|app session|sessions revoked)\b/i.test(
      message,
    )
  ) {
    return "Security";
  }
  if (
    /\b(order|trade|position|execution|halt|armed|rearm|backtest|research|strategy|fill|spread)\b/i.test(
      message,
    )
  ) {
    return "Trading";
  }
  if (
    /\b(broker|kotak|connect|connected|disconnected|credentials)\b/i.test(
      message,
    )
  ) {
    return "Broker";
  }
  if (/\b(quote|market|candle|feed|tick|chain|instrument)\b/i.test(message)) {
    return "Market";
  }
  return "Workspace";
}

/** Search only loaded owner records; no inference that this is the entire durable history. */
export function filterAuditEvents(
  events: AuditEvent[],
  category: AuditCategory,
  search: string,
): AuditEvent[] {
  const query = search.trim().toLowerCase();
  return orderAuditEvents(events).filter(
    (event) =>
      (category === "All" ||
        categorizeAuditEvent(event.message) === category) &&
      `${event.id} ${event.message}`.toLowerCase().includes(query),
  );
}

/** Use one explicit exchange timezone across the timeline, details and export. */
export function formatAuditTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "medium",
      }) + " IST"
    : "Time unavailable";
}
