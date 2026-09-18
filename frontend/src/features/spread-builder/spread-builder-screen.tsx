"use client";
/** Spread authorship reuses broker-neutral research, not the real-money order ticket. */
import { ResearchWorkbench } from "@/features/research/research-workbench";
import type { ResearchLeg } from "@/features/research/research-workbench";
/** Start empty: strikes, expiries, units and premiums must come from actual selected contracts. */
export function SpreadBuilderScreen({
  csrf,
  initialStrategyId = "",
  draftLegs,
  onDraftLegsChange,
}: {
  csrf: string;
  initialStrategyId?: string;
  draftLegs?: ResearchLeg[];
  onDraftLegsChange?: (legs: ResearchLeg[]) => void;
}) {
  return (
    <ResearchWorkbench
      csrf={csrf}
      initialMarket="options"
      initialStrategyId={initialStrategyId}
      draftLegs={draftLegs}
      onDraftLegsChange={onDraftLegsChange}
    />
  );
}
