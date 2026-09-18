"use client";
/** A dedicated local database application, deliberately separate from the trading workspace UI. */
import { Database, LogOut } from "lucide-react";
import { AuthScreen } from "@/features/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { useWorkspaceSession } from "@/features/workspace/use-workspace-session";
import { DatabaseScreen } from "./database-screen";

export function DatabaseApp() {
  const session = useWorkspaceSession();
  if (!session.workspace) {
    return (
      <main className="database-app-auth">
        <div className="database-app-brand">
          <Database aria-hidden="true" /> NRAlgo database
        </div>
        <AuthScreen
          auth={session.auth}
          error={session.error}
          busy={session.busy}
          onRefresh={session.onRefresh}
          onAuthenticate={session.onAuthenticate}
          onClearError={session.onClearError}
        />
      </main>
    );
  }
  return (
    <main className="database-app">
      <header className="database-app-header">
        <div>
          <span className="database-app-brand">
            <Database aria-hidden="true" /> NRAlgo database
          </span>
          <small>PostgreSQL workspace browser</small>
        </div>
        <div className="database-account">
          <span>{session.workspace.username}</span>
          <Button variant="secondary" onClick={() => void session.onSignOut()}>
            <LogOut size={15} aria-hidden="true" /> Sign out
          </Button>
        </div>
      </header>
      <DatabaseScreen />
    </main>
  );
}
