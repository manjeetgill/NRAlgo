"use client";
/** Saved-strategy entry point; research authorship does not grant live deployment permission. */
import { StrategyLabScreen } from "@/features/strategy-lab/strategy-lab-screen";
import { PaperStrategiesScreen } from "./paper-strategies-screen";
import type { WorkspaceSnapshot } from "@/features/workspace/workspace-types";
/** Keep synthetic EMA controls gated while preserving shared research in live presentation mode. */
export function StrategiesScreen({
  workspace,
  onRefresh,
}: {
  workspace: WorkspaceSnapshot;
  onRefresh: () => Promise<void>;
}) {
  return workspace.paper_trading_enabled ? (
    <PaperStrategiesScreen workspace={workspace} onRefresh={onRefresh} />
  ) : (
    <StrategyLabScreen csrf={workspace.csrf} />
  );
}
