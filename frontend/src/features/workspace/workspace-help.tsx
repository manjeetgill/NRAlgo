"use client";
import { useEffect, useRef, useState } from "react";
import { CircleHelp, Maximize, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkspacePage } from "./workspace-types";

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
              Paper trading uses a separate virtual ledger when enabled. Real
              trading requires explicit authorization.
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
