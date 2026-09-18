"use client";
/** Spread authorship reuses broker-neutral research, not the real-money order ticket. */
import { ResearchWorkbench } from "@/features/research/research-workbench";
import type { ResearchDraft } from "@/features/research/research-draft";
/** Start empty: strikes, expiries, units and premiums must come from actual selected contracts. */
export function SpreadBuilderScreen({
  csrf,
  initialStrategyId = "",
  draft,
  onDraftChange,
}: {
  csrf: string;
  initialStrategyId?: string;
  draft?: ResearchDraft;
  onDraftChange?: (draft: ResearchDraft) => void;
}) {
  return (
    <ResearchWorkbench
      csrf={csrf}
      initialMarket="options"
      initialStrategyId={initialStrategyId}
      draft={draft}
      onDraftChange={onDraftChange}
    />
  );
}
