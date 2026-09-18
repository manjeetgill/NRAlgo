/** Pure regressions for session request fencing and untrusted JSON boundaries. No broker I/O. */
import assert from "node:assert/strict";
import test from "node:test";
import { createLatestRequest } from "../../frontend/src/lib/latest-request";
import {
  parseAuthStatus,
  parseWorkspaceSnapshot,
} from "../../frontend/src/features/workspace/workspace-api";

test("superseded and unmounted reads cannot revive an earlier account", /** Model a slow workspace read followed by auth-policy resolution and logout. */ async () => {
  const gate = createLatestRequest();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  gate.invalidate();
  await Promise.resolve();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
  const remounted = gate.begin();
  assert.equal(remounted.isCurrent(), true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), false);
});

test("malformed workspace data fails before reaching account components", /** Missing account collections must never be treated as a flat or empty portfolio. */ () => {
  const valid = {
    username: "test",
    csrf: "csrf",
    halted: false,
    paper_trading_enabled: false,
    strategies: [],
    jobs: [],
    events: [],
  };
  assert.deepEqual(parseWorkspaceSnapshot(valid), valid);
  for (const invalid of [
    null,
    {},
    { ...valid, username: "" },
    { ...valid, csrf: null },
    { ...valid, paper_trading_enabled: "false" },
    { ...valid, jobs: null },
    { ...valid, strategies: [{ id: "invalid" }] },
    { ...valid, events: [{ id: 1, message: null }] },
  ]) {
    assert.throws(() => parseWorkspaceSnapshot(invalid), /incomplete/);
  }
});

test("authentication policy requires explicit booleans", /** UI flags are not execution permissions and cannot be inferred from strings. */ () => {
  const policy = {
    setup_required: false,
    setup_token_required: false,
    registration_enabled: true,
    invite_required: true,
  };
  assert.deepEqual(parseAuthStatus(policy), policy);
  assert.throws(
    () => parseAuthStatus({ ...policy, registration_enabled: "true" }),
    /unavailable/,
  );
});
