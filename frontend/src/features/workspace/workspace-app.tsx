"use client";
/** Changing accounts/CSRF clears every screen's private ephemeral state. */
import { AuthScreen } from "@/features/auth/auth-screen";
import { useWorkspaceSession } from "./use-workspace-session";
import { WorkspaceShell } from "./workspace-shell";
/** Mount authentication or the private shell without conditional hooks or shared form state. */
export function WorkspaceApp() {
  const session = useWorkspaceSession();
  return session.workspace ? (
    <WorkspaceShell
      key={`${session.workspace.username}:${session.workspace.csrf}`}
      workspace={session.workspace}
      error={session.error}
      busy={session.busy}
      onRefresh={session.onRefresh}
      onSignOut={session.onSignOut}
    />
  ) : (
    <AuthScreen
      auth={session.auth}
      error={session.error}
      busy={session.busy}
      onRefresh={session.onRefresh}
      onAuthenticate={session.onAuthenticate}
      onClearError={session.onClearError}
    />
  );
}
