"use client";
/** Owner-scoped audit presentation. Filtering never changes the durable server audit. */
import { Check, Clock3 } from "lucide-react";
import { isTradingEventVisible, type TradingMode } from "@/lib/trading-mode";
import type { WorkspaceSnapshot } from "@/features/workspace/workspace-types";
/** Render the latest bounded activity snapshot using the selected presentation mode. */
export function ActivityScreen({
  workspace,
  tradingMode,
}: {
  workspace: WorkspaceSnapshot;
  tradingMode: TradingMode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h3>Workspace activity</h3>
          <p>Latest 50 events · stored in your database</p>
        </div>
        <Clock3 size={18} />
      </div>
      <div className="timeline">
        {workspace.events
          .filter(
            /** Keep this mode's activity view separate without deleting audit history. */ (
              event,
            ) => isTradingEventVisible(event.message, tradingMode),
          )
          .map((e) => (
            <div key={e.id}>
              <span className="timeline-dot">
                <Check size={12} />
              </span>
              <div>
                <strong>{e.message}</strong>
                <time>{new Date(e.created_at).toLocaleString("en-IN")}</time>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}
