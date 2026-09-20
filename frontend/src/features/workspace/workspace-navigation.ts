/** Single navigation registry: screen identity, labels and icons do not live in request handlers. */
import {
  ArrowDownLeft,
  Blocks,
  Clock3,
  Database,
  FlaskConical,
  LayoutDashboard,
  BriefcaseBusiness,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { WorkspacePage } from "./workspace-types";
export const workspaceNavigation: ReadonlyArray<{
  name: WorkspacePage;
  icon: typeof Blocks;
}> = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Watchlists", icon: Database },
  { name: "Portfolio", icon: BriefcaseBusiness },
  { name: "Strategies", icon: Blocks },
  { name: "Strategy library", icon: Blocks },
  { name: "Backtest studio", icon: FlaskConical },
  { name: "Strategy lab", icon: FlaskConical },
  { name: "Spread builder", icon: Blocks },
  { name: "Option chain", icon: Database },
  { name: "Orders & trades", icon: ArrowDownLeft },
  { name: "Brokers", icon: Wallet },
  { name: "Live trading", icon: ShieldCheck },
  { name: "Account & security", icon: ShieldCheck },
  { name: "Activity log", icon: Clock3 },
];

/** Six top-level sections; existing page identities and bookmarks remain unchanged. */
export const workspaceSections: ReadonlyArray<{
  label: string;
  icon: typeof Blocks;
  pages: readonly WorkspacePage[];
}> = [
  { label: "Overview", icon: LayoutDashboard, pages: ["Overview"] },
  {
    label: "Strategies",
    icon: Blocks,
    pages: ["Strategies", "Strategy library", "Strategy lab", "Spread builder"],
  },
  { label: "Backtesting", icon: FlaskConical, pages: ["Backtest studio"] },
  {
    label: "Markets",
    icon: Database,
    pages: ["Watchlists", "Portfolio", "Option chain"],
  },
  {
    label: "Trading",
    icon: ArrowDownLeft,
    pages: ["Orders & trades", "Live trading"],
  },
  {
    label: "Settings",
    icon: ShieldCheck,
    pages: ["Brokers", "Account & security", "Activity log"],
  },
];

/** Human-facing screen names stay independent from the stable internal navigation keys. */
export const workspacePageLabels: Partial<Record<WorkspacePage, string>> = {
  "Strategy lab": "Algo lab",
  Brokers: "Broker connections",
  "Live trading": "Live positions",
  "Activity log": "Audit log",
};

/** Screen-specific guidance follows the reference's hierarchy without fictional operating states. */
export const workspacePageDescriptions: Partial<Record<WorkspacePage, string>> =
  {
    Strategies: "Manage saved strategies and continue your research.",
    "Strategy library":
      "Explore transparent rules before configuring a historical backtest.",
    "Backtest studio":
      "Validate signal strategies against stored historical daily OHLC data.",
    "Strategy lab":
      "Test a scheduled daily cash basket. For EMA, RSI or breakout signals, use Backtest Studio.",
    "Spread builder":
      "Build option baskets from current and open-expiry market data.",
    "Option chain":
      "Explore listed contracts and prices from the shared market feed.",
    Portfolio: "View one connected broker portfolio or club all real accounts.",
    Watchlists:
      "Your scrips, one click to chart. Stored daily data · no broker required.",
    "Orders & trades":
      "Search and inspect records from the selected account domain.",
    Brokers:
      "Manage broker connections independently from execution permission.",
    "Live trading":
      "Track open exposure and review explicitly authorized execution.",
    "Account & security":
      "Manage your workspace profile, authentication and active sessions.",
    "Activity log": "A readable history of actions recorded in your workspace.",
  };

/** Use one label for the sidebar, breadcrumb and page heading. */
export function getWorkspacePageLabel(page: WorkspacePage): string {
  return workspacePageLabels[page] ?? page;
}

/** Stable, readable fragment routes contain no account identifiers or credentials. */
export function getWorkspacePageHash(page: WorkspacePage): string {
  const referenceRoutes: Partial<Record<WorkspacePage, string>> = {
    "Orders & trades": "orders",
    Brokers: "brokers",
    "Account & security": "security",
    "Activity log": "audit",
  };
  if (referenceRoutes[page]) {
    return `#/${referenceRoutes[page]}`;
  }
  return `#/${getWorkspacePageLabel(page)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")}`;
}

/** Accept existing bookmarks while emitting the reference's canonical fragments. */
export function resolveWorkspacePage(hash: string): WorkspacePage | undefined {
  return [
    ...workspaceNavigation.map((item) => item.name),
    "Learn the stack" as const,
  ].find(
    (page) =>
      getWorkspacePageHash(page) === hash ||
      `#/${getWorkspacePageLabel(page)
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")}` === hash,
  );
}
