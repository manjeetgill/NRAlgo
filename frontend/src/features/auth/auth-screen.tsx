"use client";
/** Application login/setup view. Credentials stay in the form and are never persisted by the UI. */
import { useState, type FormEvent } from "react";
import {
  Activity,
  ArrowRight,
  Code2,
  ShieldCheck,
  LockKeyhole,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AuthStatus } from "@/features/workspace/workspace-types";
/** Render account policy; the session hook owns transport, cancellation and error handling. */
export function AuthScreen({
  auth,
  busy,
  error,
  onAuthenticate,
  onRefresh,
  onClearError,
}: {
  auth: AuthStatus | null;
  busy: boolean;
  error: string;
  onAuthenticate: (
    data: Record<string, FormDataEntryValue>,
    registering: boolean,
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
}) {
  const [registering, setRegistering] = useState(false);
  /** Read credentials only on explicit submit; clear the password field after the attempt. */
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      await onAuthenticate(data, registering);
    } finally {
      form.reset();
    }
  }
  return (
    <main className="auth-shell">
      <div className="auth-story">
        <a className="brand">
          <span className="brand-symbol">
            <Activity size={24} />
          </span>
          NRIAlgo<span className="brand-dot">.</span>
        </a>
        <div>
          <span className="eyebrow">YOUR EDGE. YOUR WORKSPACE.</span>
          <h1>
            Build with intent.
            <br />
            Trade with clarity.
          </h1>
          <p>
            A home for your trading ideas—from the first line of JavaScript to
            your next trading decision.
          </p>
          <div className="auth-pills">
            <span>
              <Code2 size={15} /> JavaScript powered
            </span>
            <span>
              <ShieldCheck size={15} /> Controlled execution
            </span>
          </div>
        </div>
        <small>YOUR ACCOUNT · YOUR PRIVATE WORKSPACE</small>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <span className="icon-tile">
            <LockKeyhole size={22} />
          </span>
          <h2>
            {auth?.setup_required || registering
              ? "Create your account."
              : "Welcome back."}
          </h2>
          <p>
            {auth?.setup_required || registering
              ? "Create a private workspace for your strategies and broker connections."
              : "Sign in to your personal trading workspace."}
          </p>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {auth ? (
            <form onSubmit={onSubmit}>
              <label>
                Username
                <input
                  name="username"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={80}
                  pattern="[a-zA-Z0-9_.@-]+"
                  placeholder="Your username"
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    auth.setup_required || registering
                      ? "new-password"
                      : "current-password"
                  }
                  minLength={12}
                  maxLength={128}
                  required
                  placeholder="At least 12 characters"
                />
              </label>
              {auth.setup_required && auth.setup_token_required && (
                <label>
                  Setup token
                  <input name="setup_token" type="password" required />
                </label>
              )}
              {!auth.setup_required && !registering && (
                <label>
                  Authenticator or recovery code (if enabled)
                  <input
                    name="token"
                    autoComplete="one-time-code"
                    maxLength={32}
                  />
                </label>
              )}
              {registering && !auth.setup_required && auth.invite_required && (
                <label>
                  Invitation token
                  <input
                    name="invite_token"
                    type="password"
                    required
                    autoComplete="off"
                  />
                </label>
              )}
              <Button disabled={busy} className="w-full">
                {busy
                  ? "Please wait…"
                  : auth.setup_required || registering
                    ? "Create account"
                    : "Sign in"}
                <ArrowRight size={16} />
              </Button>
              {!auth.setup_required && auth.registration_enabled && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setRegistering(!registering);
                    onClearError();
                  }}
                >
                  {registering
                    ? "Already have an account? Sign in"
                    : "Create another account"}
                </Button>
              )}
            </form>
          ) : (
            <Button onClick={() => void onRefresh()} variant="secondary">
              {error ? "Retry connection" : "Connecting to Node.js…"}
            </Button>
          )}
          <div className="auth-note">
            <ShieldCheck size={16} />
            <span>Private workspaces · Explicit trading authorization</span>
          </div>
        </div>
      </div>
    </main>
  );
}
