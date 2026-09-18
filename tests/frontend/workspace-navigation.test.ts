/** Fragment routes are public presentation identifiers, not account capabilities. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkspacePageHash,
  getWorkspacePageLabel,
  workspaceNavigation,
} from "../../frontend/src/features/workspace/workspace-navigation";

test("each workspace screen has a unique public route and reference label", () => {
  const routes = workspaceNavigation.map((item) =>
    getWorkspacePageHash(item.name),
  );
  assert.equal(new Set(routes).size, routes.length);
  assert.equal(getWorkspacePageHash("Strategy lab"), "#/algo-lab");
  assert.equal(getWorkspacePageLabel("Brokers"), "Broker connections");
  assert.equal(getWorkspacePageLabel("Activity log"), "Audit log");
});
