"use client";
/** Algo lab owns its route; the shared research workbench contains no execution commands. */
import { ResearchWorkbench } from "@/features/research/research-workbench";
/** Open the selected real saved definition, or a cash research draft. */
export function StrategyLabScreen({
  csrf,
  initialStrategyId = "",
}: {
  csrf: string;
  initialStrategyId?: string;
}) {
  return (
    <ResearchWorkbench csrf={csrf} initialStrategyId={initialStrategyId} />
  );
}
