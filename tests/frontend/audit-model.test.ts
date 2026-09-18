/** Audit filters never invent records, classify outcome as success, or modify the input. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  categorizeAuditEvent,
  filterAuditEvents,
  formatAuditTime,
  orderAuditEvents,
} from "../../frontend/src/features/activity/audit-model";

test("01-T05 server time wins over delivery/ID order and duplicate events render only once", () => {
  const event = { id: 1, message: "A", created_at: "2026-09-18T20:00:00Z" };
  const older = { id: 99, message: "B", created_at: "2026-09-18T10:00:00Z" };
  const sameTime = { ...event, id: 2 };
  const rows = [older, event, sameTime, event, event];
  assert.deepEqual(
    orderAuditEvents(rows).map((item) => item.id),
    [2, 1, 99],
  );
  assert.equal(rows.length, 5);
  assert.equal(filterAuditEvents(rows, "All", "").length, 3);
});
test("13-T03 IST date boundary renders the exchange date, independent of browser timezone", () => {
  assert.match(formatAuditTime("2026-09-18T18:29:59Z"), /18 Sept 2026/);
  assert.match(formatAuditTime("2026-09-18T18:30:00Z"), /19 Sept 2026/);
});

test("audit categories prefer security/execution over incidental broker names", () => {
  assert.equal(categorizeAuditEvent("Kotak order rejected"), "Trading");
  assert.equal(
    categorizeAuditEvent("MFA enabled; broker disconnected"),
    "Security",
  );
  assert.equal(categorizeAuditEvent("Kotak connected"), "Broker");
  assert.equal(categorizeAuditEvent("Quote feed unavailable"), "Market");
  assert.equal(categorizeAuditEvent("Workspace created"), "Workspace");
});
test("audit filtering intersects category and search without changing records", () => {
  const records = [
    {
      id: 12,
      message: "Kotak order rejected",
      created_at: "2026-09-18T06:00:00Z",
    },
    { id: 13, message: "Kotak connected", created_at: "2026-09-18T07:00:00Z" },
  ];
  assert.deepEqual(filterAuditEvents(records, "Trading", " KOTAK "), [
    records[0],
  ]);
  assert.deepEqual(filterAuditEvents(records, "All", "13"), [records[1]]);
  assert.deepEqual(filterAuditEvents(records, "Security", ""), []);
  assert.equal(records.length, 2);
  assert.match(formatAuditTime(records[0].created_at), /IST$/);
  assert.equal(formatAuditTime("bad-date"), "Time unavailable");
});
