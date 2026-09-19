"use client";

/** Dedicated historical options simulator; it never receives a live-order callback. */
import { OptionsWorkspace } from "./spread-builder-screen";

/** Render stored historical chains and payoff analysis on a permanent simulator route. */
export function SimulatorScreen({ csrf }: { csrf: string }) {
  /** Replay legs remain local to the simulator and cannot cross into live execution. */
  const rejectLiveLeg = () =>
    "Historical simulator positions cannot be sent to a broker.";

  return (
    <OptionsWorkspace
      csrf={csrf}
      experience="simulator"
      onAddLeg={rejectLiveLeg}
    />
  );
}
