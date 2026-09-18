"use client";
/** Spread authorship reuses broker-neutral research, not the real-money order ticket. */
import { ResearchWorkbench } from "@/features/research/research-workbench";
/** Start empty: strikes, expiries, units and premiums must come from actual selected contracts. */
export function SpreadBuilderScreen({
  csrf,
  initialStrategyId = "",
}: {
  csrf: string;
  initialStrategyId?: string;
}) {
  return (
    <ResearchWorkbench
      csrf={csrf}
      initialMarket="options"
      initialStrategyId={initialStrategyId}
    />
  );
}
