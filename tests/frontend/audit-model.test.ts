/** Audit filters never invent records, classify outcome as success, or modify the input. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  categorizeAuditEvent,
  filterAuditEvents,
  formatAuditTime,
} from "../../frontend/src/features/activity/audit-model";

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
