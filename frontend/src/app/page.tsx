/** Next.js route entry only. Screen layouts and session logic belong to feature modules. */
import { WorkspaceApp } from "@/features/workspace/workspace-app";
import { DatabaseApp } from "@/features/database/database-app";
/** Render the broker-neutral root without server-side broker calls or credentials. */
export default function TradingWorkspacePage() {
  return process.env.DATABASE_UI === "1" ? <DatabaseApp /> : <WorkspaceApp />;
}
