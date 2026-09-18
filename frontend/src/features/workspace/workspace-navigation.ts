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
  { name: "Strategy lab", icon: FlaskConical },
  { name: "Spread builder", icon: Blocks },
  { name: "Broker paper", icon: Radio },
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
