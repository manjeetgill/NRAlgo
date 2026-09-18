"use client";
/** Shared layout owns navigation only. Session, forms, quotes and broker commands have separate owners. */
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  LockKeyhole,
  LogOut,
  Menu,
  X,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getTradingMode, isTradingPageVisible } from "@/lib/trading-mode";
import {
  getWorkspacePageHash,
  getWorkspacePageLabel,
  workspaceNavigation,
} from "./workspace-navigation";
import { WorkspaceContent } from "./workspace-content";
import { ScreenErrorBoundary } from "./screen-error-boundary";
import type { WorkspacePage, WorkspaceSnapshot } from "./workspace-types";
import "./workspace-responsive.css";
/** Preserve navigation after a screen failure and remount private state after account/mode changes. */
export function WorkspaceShell({
  workspace,
  error,
  busy,
  onRefresh,
  onSignOut,
}: {
  workspace: WorkspaceSnapshot;
  error: string;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [requestedPage, setPage] = useState<WorkspacePage>("Overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [researchStrategyId, setResearchStrategyId] = useState("");
  const [marketInitialTool, setMarketInitialTool] = useState<
    "quotes" | "chain"
  >("quotes");
  const tradingMode = getTradingMode(workspace.paper_trading_enabled);
  const page = isTradingPageVisible(requestedPage, tradingMode)
    ? requestedPage
    : "Overview";
  /** Stable navigation callback lets independent screens own their effects. */
  const onNavigate = useCallback((destination: WorkspacePage) => {
    setPage(destination);
    setMenuOpen(false);
    window.location.hash = getWorkspacePageHash(destination);
  }, []);
  /** Restore deep links and browser history; unknown or hidden destinations fail back to Overview. */
  useEffect(() => {
    function restoreLocation() {
      const destination = [
        ...workspaceNavigation.map((item) => item.name),
        "Learn the stack" as const,
      ].find((item) => getWorkspacePageHash(item) === window.location.hash);
      setPage(
        destination && isTradingPageVisible(destination, tradingMode)
          ? destination
          : "Overview",
      );
      setMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }
    restoreLocation();
    window.addEventListener("hashchange", restoreLocation);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("hashchange", restoreLocation);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [tradingMode]);
  /** This shortcut changes presentation only, never account/execution permissions. */
  const onExploreOptionChain = useCallback(() => {
    setMarketInitialTool("chain");
    onNavigate("Market data");
  }, [onNavigate]);
  /** Pass a saved identity in memory; research data remains owner-checked by the API. */
  const onOpenStrategy = useCallback(
    (id: string) => {
      setResearchStrategyId(id);
      onNavigate("Strategy lab");
    },
    [onNavigate],
  );
  return (
    <div className={`app-shell${menuOpen ? " navigation-open" : ""}`}>
      {menuOpen && (
        <button
          className="navigation-overlay"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside className="sidebar" id="workspace-navigation">
        <a
          className="brand"
          href="#"
          onClick={
            /** Navigate without reloading the browser document. */ (event) => {
              event.preventDefault();
              onNavigate("Overview");
            }
          }
        >
          <span className="brand-symbol">
            <Activity size={23} />
          </span>
          NRIAlgo<span className="brand-dot">.</span>
        </a>
        <div className="workspace-selector">
          <span className="workspace-icon">M</span>
          <div>
            <strong>My workspace</strong>
            <small>Private account</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Workspace navigation">
          {workspaceNavigation
            .filter(
              /** Use the same policy for navigation and rendered content. */ (
                item,
              ) => isTradingPageVisible(item.name, tradingMode),
            )
            .map(
              /** Bind known navigation destinations, never mutation handlers. */ ({
                name,
                icon: Icon,
              }) => (
                <button
                  key={name}
                  aria-label={getWorkspacePageLabel(name)}
                  aria-current={page === name ? "page" : undefined}
                  className={page === name ? "active" : ""}
                  onClick={() => onNavigate(name)}
                >
                  <Icon size={18} />
                  <span>{getWorkspacePageLabel(name)}</span>
                </button>
              ),
            )}
        </nav>
        <div className="sidebar-bottom">
          <div className="build-card">
            <span className="tiny-label">BUILT TO LEARN</span>
            <strong>Your ideas, in JavaScript.</strong>
            <p>Explore the tools behind your workspace.</p>
            <button
              onClick={
                /** Open documentation without starting research work. */ () =>
                  onNavigate("Learn the stack")
              }
            >
              Explore the stack <ArrowUpRight size={14} />
            </button>
          </div>
          <button
            className="learn-link"
            aria-label="Learning guide"
            onClick={
              /** Accessible guide shortcut. */ () =>
                onNavigate("Learn the stack")
            }
          >
            <CircleHelp size={17} />
            <span>Learning guide</span>
          </button>
          <div className="profile">
            <span className="avatar">
              {workspace.username[0].toUpperCase()}
            </span>
            <div>
              <strong>{workspace.username}</strong>
              <small>Account member</small>
            </div>
            <button aria-label="Sign out" disabled={busy} onClick={onSignOut}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="navigation-toggle"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>{getWorkspacePageLabel(page)}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <i />
              {tradingMode === "paper" ? "Paper workspace" : "Live workspace"}
            </span>
            <span className="topbar-divider" />
            <ShieldCheck size={16} />
            <span>Private access</span>
          </div>
        </header>
        <main className="content">
          {page !== "Overview" && (
            <div className="heading">
              <div>
                <p className="eyebrow">YOUR TRADING COMMAND CENTER</p>
                <h1>{getWorkspacePageLabel(page)}</h1>
                <p>
                  {page === "Strategies" || page === "Strategy lab"
                    ? "Build and validate your ideas. Live execution requires separate authorization."
                    : page === "Orders & trades"
                      ? "Records from the selected account domain."
                      : "Your account. Your private workspace."}
                </p>
              </div>
              <Button variant="secondary" disabled={busy} onClick={onRefresh}>
                Refresh workspace
              </Button>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <ScreenErrorBoundary key={`${page}:${tradingMode}`}>
            <WorkspaceContent
              page={page}
              workspace={workspace}
              onNavigate={onNavigate}
              onRefresh={onRefresh}
              onExploreOptionChain={onExploreOptionChain}
              marketInitialTool={marketInitialTool}
              researchStrategyId={researchStrategyId}
              onOpenStrategy={onOpenStrategy}
            />
          </ScreenErrorBoundary>
          {page !== "Overview" && (
            <footer>
              <span>
                <LockKeyhole size={12} /> Personal workspace ·{" "}
                {tradingMode === "paper" ? "Paper trading" : "Live trading"}
              </span>
              <span>Next.js + Node.js · Built to grow with you</span>
            </footer>
          )}
        </main>
      </div>
    </div>
  );
}
