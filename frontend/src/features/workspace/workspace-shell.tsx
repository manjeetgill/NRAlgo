"use client";
/** Shared layout owns navigation only. Session, forms, quotes and broker commands have separate owners. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Activity, CircleHelp, LockKeyhole, LogOut, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import {
  Dialog,
  DialogActions,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  getWorkspacePageHash,
  getWorkspacePageLabel,
  workspaceSections,
  workspacePageDescriptions,
  resolveWorkspacePage,
} from "./workspace-navigation";
import { WorkspaceContent } from "./workspace-content";
import {
  ScreenErrorBoundary,
  WorkspaceHelp,
  workspaceTour,
} from "./workspace-views";
import type { WorkspacePage, WorkspaceSnapshot } from "./workspace-types";
import "./workspace.css";
import { useWorkspaceDrafts } from "./use-workspace-drafts";
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
  const currentPage = useRef<WorkspacePage>("Overview");
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const [openSection, setOpenSection] = useState("");
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [helpRequest, setHelpRequest] = useState(0);
  const navigationRef = useRef<HTMLElement>(null);
  const submenuRef = useRef<HTMLElement>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState({
    left: 8,
    bottom: 74,
  });
  const draftsOnNavigatedRef = useRef<
    (from: WorkspacePage, to: WorkspacePage) => void
  >(() => {});
  const tour = workspaceTour;
  const page = requestedPage;
  const sections = workspaceSections;
  const openSectionIndex = sections.findIndex(
    (section) => section.label === openSection,
  );
  const openSectionData = sections[openSectionIndex];
  function keepSubmenuOpen() {
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current);
    }
  }
  function scheduleSubmenuClose() {
    keepSubmenuOpen();
    hoverCloseTimer.current = setTimeout(() => setOpenSection(""), 180);
  }
  useEffect(
    () => () => {
      if (hoverCloseTimer.current) {
        clearTimeout(hoverCloseTimer.current);
      }
    },
    [],
  );
  /** Anchor to the actual button, including when the bottom dock scrolls. */
  useLayoutEffect(() => {
    if (!openSection) {
      return;
    }
    function positionSubmenu() {
      const trigger = navigationRef.current?.querySelector<HTMLButtonElement>(
        '.dock-primary > button[aria-expanded="true"]',
      );
      const menu = submenuRef.current;
      if (!trigger || !menu) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      setSubmenuPosition({
        left: Math.max(
          8,
          Math.min(
            rect.left + rect.width / 2 - menu.offsetWidth / 2,
            window.innerWidth - menu.offsetWidth - 8,
          ),
        ),
        bottom: window.innerHeight - rect.top + 8,
      });
    }
    function closeOutside(event: PointerEvent) {
      if (!navigationRef.current?.contains(event.target as Node)) {
        setOpenSection("");
      }
    }
    positionSubmenu();
    window.addEventListener("resize", positionSubmenu);
    window.addEventListener("scroll", positionSubmenu, true);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("resize", positionSubmenu);
      window.removeEventListener("scroll", positionSubmenu, true);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [openSection]);
  /** Stable navigation callback lets independent screens own their effects. */
  const onNavigate = useCallback(
    (destination: WorkspacePage, afterNavigate?: () => void) => {
      const complete = () => {
        draftsOnNavigatedRef.current(currentPage.current, destination);
        currentPage.current = destination;
        setPage(destination);
        setOpenSection("");
        window.location.hash = getWorkspacePageHash(destination);
        afterNavigate?.();
      };
      if (
        destination !== currentPage.current &&
        !window.dispatchEvent(
          new Event("workspace-before-navigate", { cancelable: true }),
        )
      ) {
        pendingNavigation.current = complete;
        setLeaveDialogOpen(true);
        return false;
      }
      complete();
      return true;
    },
    [],
  );
  /** Restore deep links and browser history; unknown or hidden destinations fail back to Overview. */
  useEffect(() => {
    function restoreLocation() {
      const destination =
        resolveWorkspacePage(window.location.hash) ?? "Overview";
      if (!onNavigate(destination)) {
        window.history.replaceState(
          null,
          "",
          getWorkspacePageHash(currentPage.current),
        );
        return;
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenSection("");
      }
    }
    restoreLocation();
    window.addEventListener("hashchange", restoreLocation);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("hashchange", restoreLocation);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onNavigate]);
  /** This shortcut changes presentation only, never account/execution permissions. */
  const onExploreOptionChain = useCallback(() => {
    onNavigate("Option chain");
  }, [onNavigate]);
  const drafts = useWorkspaceDrafts(onNavigate);
  draftsOnNavigatedRef.current = drafts.onNavigated;
  function visitTourStep(index: number) {
    onNavigate(tour[index].page, () => setTourStep(index));
  }
  return (
    <div className="app-shell">
      <Dialog
        open={leaveDialogOpen}
        onClose={() => {
          setLeaveDialogOpen(false);
          pendingNavigation.current = null;
        }}
        title="Leave unsaved research?"
        labelledBy="leave-research-title"
      >
        <DialogDescription>
          Inputs and displayed results on this screen are not automatically
          saved. Stay to keep editing, or leave and discard this local work. No
          trading order will be placed.
        </DialogDescription>
        <DialogActions>
          <Button
            variant="secondary"
            autoFocus
            onClick={() => setLeaveDialogOpen(false)}
          >
            Keep editing
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const proceed = pendingNavigation.current;
              pendingNavigation.current = null;
              setLeaveDialogOpen(false);
              proceed?.();
            }}
          >
            Discard and leave
          </Button>
        </DialogActions>
      </Dialog>
      <a
        className="workspace-skip"
        href="#workspace-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("workspace-main")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside
        ref={navigationRef}
        className="sidebar"
        id="workspace-navigation"
        aria-label="Workspace navigation menu"
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setOpenSection("");
          }
        }}
      >
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
        <div className="brand-subtitle">TRADING WORKSPACE</div>
        <div className="workspace-selector">
          <span className="workspace-icon">M</span>
          <div>
            <strong>My workspace</strong>
            <small>Private account</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="dock-primary" aria-label="Workspace navigation">
          {sections.map(({ label, icon: Icon, pages }) => (
            <button
              key={label}
              aria-label={label}
              aria-current={pages.includes(page) ? "page" : undefined}
              aria-expanded={
                pages.length > 1 ? openSection === label : undefined
              }
              aria-controls={pages.length > 1 ? "dock-submenu" : undefined}
              onPointerEnter={(event) => {
                if (event.pointerType === "touch") {
                  return;
                }
                keepSubmenuOpen();
                setOpenSection(pages.length > 1 ? label : "");
              }}
              onPointerLeave={(event) => {
                if (event.pointerType !== "touch") {
                  scheduleSubmenuClose();
                }
              }}
              className={pages.includes(page) ? "active" : ""}
              onClick={() => {
                keepSubmenuOpen();
                if (pages.length === 1) {
                  onNavigate(pages[0]);
                  return;
                }
                setOpenSection(label);
              }}
            >
              <Icon size={18} />
              <span>{label === "Backtesting" ? "Backtests" : label}</span>
            </button>
          ))}
        </nav>
        {openSectionData && openSectionData.pages.length > 1 && (
          <nav
            ref={submenuRef}
            id="dock-submenu"
            className="dock-submenu"
            onPointerEnter={keepSubmenuOpen}
            onPointerLeave={scheduleSubmenuClose}
            aria-label={`${openSectionData.label} pages`}
            style={submenuPosition}
          >
            {openSectionData.pages.map((destination) => (
              <button
                key={destination}
                type="button"
                aria-current={page === destination ? "page" : undefined}
                onClick={() => onNavigate(destination)}
              >
                {destination === "Strategies"
                  ? "My strategies"
                  : getWorkspacePageLabel(destination)}
              </button>
            ))}
            {openSection === "Settings" && (
              <button type="button" disabled={busy} onClick={onSignOut}>
                Sign out
              </button>
            )}
          </nav>
        )}
        <div className="sidebar-bottom">
          <button
            className="learn-link"
            aria-label="Workspace guide"
            onClick={
              /** Open product help without leaving the current screen. */ () =>
                setHelpRequest((value) => value + 1)
            }
          >
            <CircleHelp size={17} />
            <span>Workspace guide</span>
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
      <div className="main-shell" onClick={() => setOpenSection("")}>
        <header className="topbar">
          <div className="breadcrumb">
            <span className="breadcrumb-root">Workspace /</span>
            <strong>{getWorkspacePageLabel(page)}</strong>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <WorkspaceHelp
              username={workspace.username}
              helpRequest={helpRequest}
              busy={busy}
              onRefresh={onRefresh}
              onNavigate={onNavigate}
              onStartTour={() => visitTourStep(0)}
            />
          </div>
        </header>
        {tourStep !== null && (
          <div
            className="workspace-tour"
            role="region"
            aria-label="Product tour"
          >
            <span>
              {tourStep + 1} / {tour.length}
            </span>
            <div>
              <strong>{tour[tourStep].title}</strong>
              <p>{tour[tourStep].description}</p>
            </div>
            <Button
              variant="secondary"
              disabled={tourStep === 0}
              onClick={() => visitTourStep(tourStep - 1)}
            >
              Back
            </Button>
            <Button
              onClick={() =>
                tourStep === tour.length - 1
                  ? setTourStep(null)
                  : visitTourStep(tourStep + 1)
              }
            >
              {tourStep === tour.length - 1 ? "Finish tour" : "Next →"}
            </Button>
            <button
              className="workspace-icon-button"
              aria-label="Close tour"
              onClick={() => setTourStep(null)}
            >
              <X size={18} />
            </button>
          </div>
        )}
        <main
          className={`content${page === "Spread builder" || page === "Option chain" ? " trading-canvas" : ""}${page === "Option chain" ? " option-chain-canvas" : ""}`}
          id="workspace-main"
          tabIndex={-1}
        >
          {page !== "Overview" && (
            <div className="heading">
              <div>
                <h1>{getWorkspacePageLabel(page)}</h1>
                <p>
                  {workspacePageDescriptions[page] ??
                    "Your account. Your private workspace."}
                </p>
              </div>
              <div id="workspace-page-actions" className="page-actions" />
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <ScreenErrorBoundary key={page}>
            <WorkspaceContent
              page={page}
              workspace={workspace}
              onNavigate={onNavigate}
              onRefresh={onRefresh}
              onExploreOptionChain={onExploreOptionChain}
              researchStrategyId={drafts.researchStrategyId}
              onOpenStrategy={drafts.onOpenStrategy}
              templateId={drafts.templateId}
              onConfigureTemplate={drafts.onConfigureTemplate}
              spreadDraft={drafts.spreadDraft}
              spreadContext={drafts.spreadContext}
              onOpenBuilder={drafts.onOpenBuilder}
              onAddSpreadLeg={drafts.onAddSpreadLeg}
            />
          </ScreenErrorBoundary>
          {page !== "Overview" && (
            <footer>
              <span>
                <LockKeyhole size={12} /> Personal trading workspace
              </span>
              <span>Account-scoped data · Explicit execution approval</span>
            </footer>
          )}
        </main>
      </div>
    </div>
  );
}
