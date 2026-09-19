"use client";
/** Owner-scoped audit viewer. Filters and exports never mutate the durable server history. */
import { useCallback, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageActions } from "@/features/workspace/workspace-views";
import { downloadText, encodeCsv } from "@/lib/download";
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
  onRefresh,
}: {
  workspace: WorkspaceSnapshot;
  onRefresh: () => Promise<void>;
}) {
  const [category, setCategory] = useState<AuditCategory>("All");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshPending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  /** Reuse the visible filtered rows for export. */
  const events = useMemo(
    () => filterAuditEvents(workspace.events, category, search),
    [workspace.events, category, search],
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
    <section className="screen-stack audit-screen">
      <PageActions>
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
          Export history
        </Button>
      </PageActions>
      <section className="panel screen-card">
        <div className="audit-toolbar">
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
          <label className="audit-search">
            <span className="sr-only">Search audit log</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search event, instrument or ID"
            />
          </label>
        </div>
        <div className="audit-timeline">
          {events.map((event) => (
            <div key={event.id}>
              <time dateTime={event.created_at}>
                {formatAuditTime(event.created_at)}
              </time>
              <span className="timeline-dot" aria-hidden="true">
                •
              </span>
              <div>
                <button
                  type="button"
                  className="audit-event-button"
                  onClick={() => {
                    setSelected(event);
                    dialog.current?.showModal();
                  }}
                >
                  {event.message}
                </button>
                <p className="muted">Workspace event #{event.id}</p>
              </div>
              <span className="badge">
                {categorizeAuditEvent(event.message)}
              </span>
            </div>
          ))}
        </div>
        {!events.length && (
          <p role="status">No loaded events match these filters.</p>
        )}
        <p className="muted audit-footnote">
          Latest 50 loaded account events · times shown in IST. Categories are
          derived from recorded event text.
        </p>
      </section>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        aria-labelledby="audit-detail-title"
        onClose={() => setSelected(null)}
      >
        <div className="panel-heading">
          <h3 id="audit-detail-title">
            {selected?.message ?? "Audit event details"}
          </h3>
          <button
            className="workspace-icon-button"
            aria-label="Close dialog"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
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
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
      </dialog>
    </section>
  );
}
