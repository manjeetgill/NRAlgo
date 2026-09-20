"use client";
/** Owner-scoped audit viewer. Filters and exports never mutate the durable server history. */
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog, DialogActions } from "@/components/ui/dialog";
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

/** Purely presentational grouping of derived categories; never a server-asserted severity. */
const CATEGORY_TONE: Record<Exclude<AuditCategory, "All">, BadgeTone> = {
  Security: "danger",
  Trading: "accent",
  Broker: "info",
  Market: "warning",
  Workspace: "neutral",
};

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
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshPending = useRef(false);
  const invalidRange = Boolean(fromDay && toDay && fromDay > toDay);
  /** Reuse the visible filtered rows for export. */
  const events = useMemo(
    () =>
      filterAuditEvents(workspace.events, category, search).filter((event) => {
        // Calendar filters use IST, matching the displayed event time, not the browser's zone.
        const timestamp = Date.parse(event.created_at);
        const day = Number.isFinite(timestamp)
          ? new Date(timestamp + 330 * 60_000).toISOString().slice(0, 10)
          : "";
        return (
          (!fromDay || day >= fromDay) &&
          (!toDay || (Boolean(day) && day <= toDay))
        );
      }),
    [workspace.events, category, search, fromDay, toDay],
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
  const columns: DataTableColumn<AuditEvent>[] = [
    {
      key: "time",
      header: "Time (IST)",
      width: "180px",
      sortValue: (event) => {
        const value = Date.parse(event.created_at);
        return Number.isFinite(value) ? value : 0;
      },
      render: (event) => (
        <time dateTime={event.created_at}>
          {formatAuditTime(event.created_at)}
        </time>
      ),
    },
    {
      key: "event",
      header: "Event",
      render: (event) => (
        <div>
          <button
            type="button"
            className="audit-event-button"
            onClick={() => {
              setSelected(event);
              setDetailOpen(true);
            }}
          >
            {event.message}
          </button>
          <p className="muted">Workspace event #{event.id}</p>
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      width: "140px",
      sortValue: (event) => categorizeAuditEvent(event.message),
      render: (event) => {
        const derived = categorizeAuditEvent(event.message);
        return <Badge tone={CATEGORY_TONE[derived]}>{derived}</Badge>;
      },
    },
  ];
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
          disabled={invalidRange || !events.length}
          onClick={exportEvents}
        >
          Export filtered events
        </Button>
      </PageActions>
      <Card>
        <div className="audit-toolbar">
          <Tabs
            items={AUDIT_CATEGORIES.map((item) => ({ key: item, label: item }))}
            active={category}
            onChange={(key) => setCategory(key as AuditCategory)}
          />
          <label className="audit-search">
            <span className="sr-only">Search audit log</span>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search event, instrument or ID"
            />
          </label>
        </div>
        <div className="screen-toolbar">
          <Field label="From date (IST)" htmlFor="audit-from-day">
            <Input
              id="audit-from-day"
              type="date"
              value={fromDay}
              max={toDay || undefined}
              onChange={(event) => setFromDay(event.target.value)}
            />
          </Field>
          <Field label="To date (IST)" htmlFor="audit-to-day">
            <Input
              id="audit-to-day"
              type="date"
              value={toDay}
              min={fromDay || undefined}
              onChange={(event) => setToDay(event.target.value)}
            />
          </Field>
          <Button
            variant="secondary"
            onClick={() => {
              setFromDay("");
              setToDay("");
              setSearch("");
              setCategory("All");
            }}
          >
            Clear filters
          </Button>
        </div>
        {invalidRange && (
          <p role="alert" className="error">
            From date must be on or before To date.
          </p>
        )}
        <p className="muted">
          Showing {events.length} of {workspace.events.length} loaded events.
          Filters and exports apply only to this recent snapshot, not the full
          audit archive.
        </p>
        <DataTable
          columns={columns}
          rows={events}
          rowKey={(event) => String(event.id)}
          defaultSort={{ key: "time", direction: "desc" }}
          emptyTitle="No loaded events match these filters."
        />
        <p className="muted audit-footnote">
          Latest 50 loaded account events · times shown in IST. Categories are
          derived from recorded event text.
        </p>
      </Card>
      <Dialog
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelected(null);
        }}
        title={selected?.message ?? "Audit event details"}
        labelledBy="audit-detail-title"
      >
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
        <DialogActions>
          <Button variant="secondary" onClick={() => setDetailOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </section>
  );
}
