import assert from "node:assert/strict";
import test from "node:test";
import { workspaceTour } from "../../frontend/src/features/workspace/workspace-tour";
import {
  getWorkspacePageHash,
  resolveWorkspacePage,
} from "../../frontend/src/features/workspace/workspace-navigation";
import { isTradingPageVisible } from "../../frontend/src/lib/trading-mode";

test("product tour follows reference destinations without exposing hidden paper execution", () => {
  assert.deepEqual(
    workspaceTour.map((step) => getWorkspacePageHash(step.page)),
    [
      "#/overview",
      "#/option-chain",
      "#/spread-builder",
      "#/paper",
      "#/orders",
      "#/audit",
    ],
  );
  const liveSteps = workspaceTour.filter((step) =>
    isTradingPageVisible(step.page, "live"),
  );
  assert.equal(liveSteps.length, 5);
  assert.ok(liveSteps.every((step) => step.page !== "Broker paper"));
  for (const step of workspaceTour) {
    assert.equal(
      resolveWorkspacePage(getWorkspacePageHash(step.page)),
      step.page,
    );
    assert.ok(step.description.length > 0);
  }
});
