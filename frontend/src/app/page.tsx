/** Next.js route entry only. Screen layouts and session logic belong to feature modules. */
import { WorkspaceApp } from "@/features/workspace/workspace-app";
/** Render the broker-neutral root without server-side broker calls or credentials. */
export default function TradingWorkspacePage() {
  return <WorkspaceApp />;
}
