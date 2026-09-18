/** Single navigation registry: screen identity, labels and icons do not live in request handlers. */
import {
  ArrowDownLeft,
  Blocks,
  Clock3,
  Database,
  FlaskConical,
  LayoutDashboard,
  Radio,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { WorkspacePage } from "./workspace-types";
export const workspaceNavigation: ReadonlyArray<{
  name: WorkspacePage;
  icon: typeof Blocks;
}> = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Strategies", icon: Blocks },
  { name: "Strategy library", icon: Blocks },
  { name: "Backtest studio", icon: FlaskConical },
  { name: "Strategy lab", icon: FlaskConical },
  { name: "Spread builder", icon: Blocks },
  { name: "Broker paper", icon: Radio },
  { name: "Option chain", icon: Database },
  { name: "Market data", icon: Database },
  { name: "Orders & trades", icon: ArrowDownLeft },
  { name: "Brokers", icon: Wallet },
  { name: "Live trading", icon: ShieldCheck },
  { name: "Account & security", icon: ShieldCheck },
  { name: "Activity log", icon: Clock3 },
];

/** Human-facing screen names stay independent from the stable internal navigation keys. */
export const workspacePageLabels: Partial<Record<WorkspacePage, string>> = {
  "Strategy lab": "Algo lab",
  "Broker paper": "Paper trading",
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
      "Validate signal strategies against your historical OHLC data.",
    "Strategy lab":
      "Build and replay scheduled strategies using broker historical candles.",
    "Spread builder":
      "Select option contracts and evaluate the risk of your basket.",
    "Broker paper":
      "Review quote-driven orders in your separate virtual account.",
    "Option chain":
      "Explore listed contracts and prices from the shared market feed.",
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
  return `#/${getWorkspacePageLabel(page)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")}`;
}
