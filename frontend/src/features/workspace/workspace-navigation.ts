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
  { name: "Strategy lab", icon: FlaskConical },
  { name: "Broker paper", icon: Radio },
  { name: "Market data", icon: Database },
  { name: "Orders & trades", icon: ArrowDownLeft },
  { name: "Brokers", icon: Wallet },
  { name: "Live trading", icon: ShieldCheck },
  { name: "Account & security", icon: ShieldCheck },
  { name: "Activity log", icon: Clock3 },
];
