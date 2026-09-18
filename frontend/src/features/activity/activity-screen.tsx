"use client";
/** Owner-scoped audit viewer. Filters and exports never mutate the durable server history. */
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadText, encodeCsv } from "@/lib/download";
import { isTradingEventVisible, type TradingMode } from "@/lib/trading-mode";
import type { WorkspaceSnapshot } from "@/features/workspace/workspace-types";
import {
  AUDIT_CATEGORIES,
  categorizeAuditEvent,
  filterAuditEvents,
  formatAuditTime,
  type AuditCategory,
  type AuditEvent,
} from "./audit-model";

/** Present loaded events with a bounded refresh, deterministic filters and keyboard-accessible details. */
export function ActivityScreen({
  workspace,
  tradingMode,
  onRefresh,
}: {
  workspace: WorkspaceSnapshot;
  tradingMode: TradingMode;
  onRefresh: () => Promise<void>;
}) {
  const [category, setCategory] = useState<AuditCategory>("All");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshPending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  /** Keep paper visibility separate from the immutable owner audit; reuse filtered rows for export. */
  const events = useMemo(
    () =>
      filterAuditEvents(
        workspace.events.filter((event) =>
          isTradingEventVisible(event.message, tradingMode),
        ),
        category,
        search,
      ),
    [workspace.events, tradingMode, category, search],
  );
  /** A manual workspace read updates the audit snapshot; quote ticks do not refetch history. */
  const refresh = useCallback(async () => {
    if (refreshPending.current) {
      return;
    }
    refreshPending.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      refreshPending.current = false;
      setRefreshing(false);
    }
  }, [onRefresh]);
  /** Export exactly the visible records, escaping untrusted message cells for spreadsheet safety. */
  const exportEvents = useCallback(() => {
    downloadText(
      "audit-loaded-events.csv",
      encodeCsv([
        ["Event ID", "Time (IST)", "Derived category", "Message"],
        ...events.map((event) => [
          event.id,
          formatAuditTime(event.created_at),
          categorizeAuditEvent(event.message),
          event.message,
        ]),
      ]),
      "text/csv",
    );
  }, [events]);
  return (
    <section className="screen-stack">
      <div className="screen-toolbar">
        <p>Latest 50 loaded account events. Times shown in IST.</p>
        <div className="row-actions">
          <Button
            variant="secondary"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? "Refreshing…" : "Refresh events"}
          </Button>
          <Button
            variant="secondary"
            disabled={!events.length}
            onClick={exportEvents}
          >
            Export filtered events
          </Button>
        </div>
      </div>
      <section className="screen-card">
        <div className="tabs" aria-label="Audit categories">
          {AUDIT_CATEGORIES.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={category === item}
              className={category === item ? "active" : ""}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="field">
          Search event, instrument or ID
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded events"
          />
        </label>
        <p className="muted">
          Categories are derived from event text. Filters do not remove stored
          records.
        </p>
        <div className="timeline">
          {events.map((event) => (
            <div key={event.id}>
              <span className="timeline-dot" aria-hidden="true">
                •
              </span>
              <div>
                <button
                  type="button"
                  className="chain-price-button"
                  onClick={() => {
                    setSelected(event);
                    dialog.current?.showModal();
                  }}
                >
                  {event.message}
                </button>
                <time>
                  {formatAuditTime(event.created_at)} ·{" "}
                  {categorizeAuditEvent(event.message)} · #{event.id}
                </time>
              </div>
            </div>
          ))}
        </div>
        {!events.length && (
          <p role="status">No loaded events match these filters.</p>
        )}
      </section>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        aria-labelledby="audit-detail-title"
        onClose={() => setSelected(null)}
      >
        <div className="panel-heading">
          <h3 id="audit-detail-title">Audit event details</h3>
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
        {selected && (
          <dl>
            <dt>Event ID</dt>
            <dd>{selected.id}</dd>
            <dt>Recorded time</dt>
            <dd>{formatAuditTime(selected.created_at)}</dd>
            <dt>Derived category</dt>
            <dd>{categorizeAuditEvent(selected.message)}</dd>
            <dt>Message</dt>
            <dd style={{ overflowWrap: "anywhere" }}>{selected.message}</dd>
            <dt>Source</dt>
            <dd>Your account’s stored server audit</dd>
          </dl>
        )}
      </dialog>
    </section>
  );
}
