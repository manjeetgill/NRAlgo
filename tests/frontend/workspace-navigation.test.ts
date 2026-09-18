/** Fragment routes are public presentation identifiers, not account capabilities. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkspacePageHash,
  getWorkspacePageLabel,
  workspaceNavigation,
  resolveWorkspacePage,
} from "../../frontend/src/features/workspace/workspace-navigation";

test("each workspace screen has a unique public route and reference label", () => {
  const routes = workspaceNavigation.map((item) =>
    getWorkspacePageHash(item.name),
  );
  assert.equal(new Set(routes).size, routes.length);
  assert.deepEqual(
    workspaceNavigation.map((item) => getWorkspacePageLabel(item.name)),
    [
      "Overview",
      "Strategies",
      "Strategy library",
      "Backtest studio",
      "Algo lab",
      "Spread builder",
      "Paper trading",
      "Option chain",
      "Orders & trades",
      "Broker connections",
      "Live positions",
      "Account & security",
      "Audit log",
    ],
  );
  assert.equal(getWorkspacePageHash("Strategy lab"), "#/algo-lab");
  assert.equal(getWorkspacePageLabel("Brokers"), "Broker connections");
  assert.equal(getWorkspacePageLabel("Activity log"), "Audit log");
});

test("reference routes preserve legacy bookmarks", () => {
  assert.equal(getWorkspacePageHash("Activity log"), "#/audit");
  assert.equal(getWorkspacePageHash("Account & security"), "#/security");
  assert.equal(getWorkspacePageHash("Brokers"), "#/brokers");
  assert.equal(getWorkspacePageHash("Orders & trades"), "#/orders");
  assert.equal(getWorkspacePageHash("Broker paper"), "#/paper");
  for (const item of workspaceNavigation) {
    assert.equal(
      resolveWorkspacePage(getWorkspacePageHash(item.name)),
      item.name,
    );
  }
  assert.equal(resolveWorkspacePage("#/audit-log"), "Activity log");
  assert.equal(resolveWorkspacePage("#/broker-connections"), "Brokers");
  assert.equal(resolveWorkspacePage("#/unknown"), undefined);
});
