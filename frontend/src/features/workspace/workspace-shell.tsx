"use client";
/** Shared layout owns navigation only. Session, forms, quotes and broker commands have separate owners. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Activity, CircleHelp, LockKeyhole, LogOut, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getTradingMode, isTradingPageVisible } from "@/lib/trading-mode";
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
import type { TemplateId } from "@/features/strategy-library/strategy-templates";
import {
  createResearchDefinition,
  type ResearchDraft,
} from "@/features/research/research-draft";
import type { ChainContract } from "@/components/live-option-chain";
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
  const [openSection, setOpenSection] = useState("");
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [helpRequest, setHelpRequest] = useState(0);
  const navigationRef = useRef<HTMLElement>(null);
  const [researchStrategyId, setResearchStrategyId] = useState("");
  const [templateId, setTemplateId] = useState<TemplateId>("ema");
  const [spreadDraft, setSpreadDraft] = useState<ResearchDraft>();
  const tradingMode = getTradingMode(workspace.paper_trading_enabled);
  const tour = workspaceTour.filter((step) =>
    isTradingPageVisible(step.page, tradingMode),
  );
  const page = isTradingPageVisible(requestedPage, tradingMode)
    ? requestedPage
    : "Overview";
  const sections = workspaceSections
    .map((section) => ({
      ...section,
      pages: section.pages.filter((item) =>
        isTradingPageVisible(item, tradingMode),
      ),
    }))
    .filter((section) => section.pages.length > 0);
  const openSectionIndex = sections.findIndex(
    (section) => section.label === openSection,
  );
  const openSectionData = sections[openSectionIndex];
  useEffect(() => {
    setTourStep(null);
  }, [tradingMode]);
  /** Stable navigation callback lets independent screens own their effects. */
  const onNavigate = useCallback((destination: WorkspacePage) => {
    setPage(destination);
    setOpenSection("");
    window.location.hash = getWorkspacePageHash(destination);
  }, []);
  /** Restore deep links and browser history; unknown or hidden destinations fail back to Overview. */
  useEffect(() => {
    function restoreLocation() {
      const destination = resolveWorkspacePage(window.location.hash);
      setPage(
        destination && isTradingPageVisible(destination, tradingMode)
          ? destination
          : "Overview",
      );
      setOpenSection("");
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
  }, [tradingMode]);
  /** This shortcut changes presentation only, never account/execution permissions. */
  const onExploreOptionChain = useCallback(() => {
    onNavigate("Option chain");
  }, [onNavigate]);
  /** Pass a saved identity in memory; research data remains owner-checked by the API. */
  const onOpenStrategy = useCallback(
    (id: string, market: "cash" | "options") => {
      setResearchStrategyId(id);
      if (market === "options") {
        setSpreadDraft(undefined);
      }
      onNavigate(market === "options" ? "Spread builder" : "Strategy lab");
    },
    [onNavigate],
  );
  /** Add exact master metadata to an account-scoped, in-memory draft; never create orders. */
  const onAddSpreadLeg = useCallback(
    (contract: ChainContract, side: "buy" | "sell") => {
      const spreadLegs = spreadDraft?.definition.legs ?? [];
      if (!contract.option) {
        return "Select a listed option contract.";
      }
      if (!Number.isSafeInteger(contract.lotSize) || contract.lotSize < 1) {
        return "This legacy archive does not include a verified lot size. Add the leg in the builder and enter units manually.";
      }
      if (spreadLegs.length >= 4) {
        return "A spread supports at most four legs. Remove one in the builder first.";
      }
      const option = contract.option;
      if (
        spreadLegs.some(
          (leg) =>
            leg.stockCode === contract.symbol &&
            leg.expiryDate === option.expiryDate &&
            leg.right === option.right &&
            leg.strikePrice === option.strikePrice,
        )
      ) {
        return "This contract is already in your draft. Edit its units in the builder.";
      }
      setSpreadDraft({
        savedId: "",
        definition: {
          ...(spreadDraft?.definition ?? createResearchDefinition("options")),
          legs: [
            ...spreadLegs,
            {
              stockCode: contract.symbol,
              expiryDate: option.expiryDate,
              right: option.right,
              strikePrice: option.strikePrice,
              side,
              quantity: contract.lotSize,
            },
          ],
        },
        marketReferences: [
          ...(spreadDraft?.marketReferences ?? []),
          ...(typeof contract.price === "number" && contract.price >= 0
            ? [
                {
                  stockCode: contract.symbol,
                  expiryDate: option.expiryDate,
                  right: option.right,
                  strikePrice: option.strikePrice,
                  price: contract.price,
                  observedAt: contract.tickAt,
                },
              ]
            : []),
        ],
      });
      setResearchStrategyId("");
      onNavigate("Spread builder");
      return "";
    },
    [spreadDraft, onNavigate],
  );
  /** Template selection changes research parameters only, not broker execution state. */
  const onConfigureTemplate = useCallback(
    (id: TemplateId) => {
      setTemplateId(id);
      onNavigate("Backtest studio");
    },
    [onNavigate],
  );
  function visitTourStep(index: number) {
    setTourStep(index);
    onNavigate(tour[index].page);
  }
  return (
    <div className="app-shell">
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
              className={pages.includes(page) ? "active" : ""}
              onClick={() => {
                if (pages.length === 1) {
                  onNavigate(pages[0]);
                  return;
                }
                if (!pages.includes(page)) {
                  onNavigate(pages[0]);
                }
                setOpenSection((current) => (current === label ? "" : label));
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {openSectionData && openSectionData.pages.length > 1 && (
          <nav
            className="dock-submenu"
            aria-label={`${openSectionData.label} pages`}
            style={
              {
                "--dock-position": `${((openSectionIndex + 0.5) / sections.length) * 100}%`,
              } as CSSProperties
            }
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
          <WorkspaceHelp
            username={workspace.username}
            helpRequest={helpRequest}
            busy={busy}
            onRefresh={onRefresh}
            onNavigate={onNavigate}
            onStartTour={() => visitTourStep(0)}
          />
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
          <ScreenErrorBoundary key={`${page}:${tradingMode}`}>
            <WorkspaceContent
              page={page}
              workspace={workspace}
              onNavigate={onNavigate}
              onRefresh={onRefresh}
              onExploreOptionChain={onExploreOptionChain}
              researchStrategyId={researchStrategyId}
              onOpenStrategy={onOpenStrategy}
              templateId={templateId}
              onConfigureTemplate={onConfigureTemplate}
              spreadDraft={spreadDraft}
              onAddSpreadLeg={onAddSpreadLeg}
            />
          </ScreenErrorBoundary>
          {page !== "Overview" && (
            <footer>
              <span>
                <LockKeyhole size={12} /> Personal workspace ·{" "}
                {tradingMode === "paper" ? "Paper trading" : "Live trading"}
              </span>
              <span>Account-scoped data · Explicit execution approval</span>
            </footer>
          )}
        </main>
      </div>
    </div>
  );
}
