"use client";
/**
 * Shared workspace views: page commands, screen error containment, help and presentation-only tour.
 * These controls own layout and navigation only; session and trading mutations stay with their hooks.
 * A failed screen never triggers an automatic order retry.
 */
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, Maximize, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkspacePage } from "./workspace-types";

/** A screen owns its commands; the shell supplies their common heading position. */
export function PageActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("workspace-page-actions"));
  }, []);
  return target ? (
    createPortal(children, target)
  ) : (
    <div className="page-actions">{children}</div>
  );
}

/** Contain a screen render/chunk failure without losing navigation or exposing internal errors. */
export class ScreenErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  public state = { failed: false };
  /** Render failures must not trigger automatic order retries. */
  public static getDerivedStateFromError() {
    return { failed: true };
  }
  /** Navigating to another screen resets this keyed boundary. */
  public render() {
    return this.state.failed ? (
      <section className="panel" role="alert">
        <h2>This screen could not load.</h2>
        <p>
          Use the sidebar to navigate away and return. If an order was being
          submitted, check its broker status before trying again.
        </p>
      </section>
    ) : (
      this.props.children
    );
  }
}

/** Presentation-only tour; steps never call trading or account mutation APIs. */
export const workspaceTour: ReadonlyArray<{
  page: WorkspacePage;
  title: string;
  description: string;
}> = [
  {
    page: "Overview",
    title: "Your workspace at a glance",
    description: "Review account health, recent activity and quick actions.",
  },
  {
    page: "Option chain",
    title: "Explore the option chain",
    description: "Inspect a call or put, then add a leg to your spread draft.",
  },
  {
    page: "Spread builder",
    title: "Build and review a spread",
    description:
      "Review selected legs and the payoff before considering execution.",
  },
  {
    page: "Orders & trades",
    title: "Follow the result",
    description:
      "Open Details to inspect the recorded order history, or filter the records.",
  },
  {
    page: "Activity log",
    title: "Close with the audit trail",
    description:
      "Review the actions recorded in your account. Search and export the loaded events.",
  },
];

/** Native modal keeps focus/escape behavior and never simulates a connected account. */
export function WorkspaceHelp({
  username,
  helpRequest,
  busy,
  onRefresh,
  onNavigate,
  onStartTour,
}: {
  username: string;
  helpRequest: number;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onNavigate: (page: WorkspacePage) => void;
  onStartTour: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (helpRequest > 0 && !dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, [helpRequest]);
  async function toggleFullscreen() {
    try {
      setError("");
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      setError("Full screen is unavailable in this browser.");
    }
  }
  return (
    <>
      <div className="header-tools">
        <span className="badge workspace-label">Trading workspace</span>
        <button
          className="workspace-icon-button"
          aria-label="Product tour"
          title="Product tour"
          onClick={onStartTour}
        >
          <Play size={18} />
        </button>
        <button
          className="workspace-icon-button"
          aria-label="Toggle full screen"
          title="Full screen"
          onClick={() => void toggleFullscreen()}
        >
          <Maximize size={18} />
        </button>
        <button
          className="workspace-icon-button"
          aria-label="Workspace help"
          title="Workspace help"
          onClick={() => dialog.current?.showModal()}
        >
          <CircleHelp size={18} />
        </button>
        <button
          className="workspace-avatar"
          aria-label="Account and security"
          onClick={() => onNavigate("Account & security")}
        >
          {username.slice(0, 2).toUpperCase()}
        </button>
      </div>
      {error && (
        <span className="fullscreen-error" role="status">
          {error}
        </span>
      )}
      <dialog
        ref={dialog}
        className="workspace-dialog workspace-help"
        aria-labelledby="workspace-help-title"
      >
        <div className="dialog-head">
          <h2 id="workspace-help-title">Workspace help</h2>
          <button
            className="workspace-icon-button"
            aria-label="Close dialog"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">
          <p>Explore your workspace, build strategies and review activity.</p>
          <dl>
            <dt>Research</dt>
            <dd>Start in Strategy library, Algo lab or Spread builder.</dd>
            <dt>Trading</dt>
            <dd>
              Live trading requires explicit authorization, risk checks and a
              connected broker session.
            </dd>
            <dt>Account</dt>
            <dd>Manage broker connections, security and the audit log.</dd>
          </dl>
        </div>
        <div className="dialog-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              dialog.current?.close();
              void onRefresh();
            }}
          >
            Refresh workspace
          </Button>
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Close
          </Button>
          <Button
            onClick={() => {
              dialog.current?.close();
              onStartTour();
            }}
          >
            Start product tour
          </Button>
        </div>
      </dialog>
    </>
  );
}
