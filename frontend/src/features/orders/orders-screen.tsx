"use client";
/** Route orders to the selected account domain without mixing synthetic fills and real OMS records. */
import { PaperOrdersScreen } from "./paper-orders-screen";
import { LiveOrdersScreen } from "./live-orders-screen";
import { Button } from "@/components/ui/button";
import type {
  WorkspaceSnapshot,
  WorkspacePage,
} from "@/features/workspace/workspace-types";
/** Selecting a screen is a read operation; live order commands remain in the explicit execution screen. */
export function OrdersScreen({
  workspace,
  onNavigate,
}: {
  workspace: WorkspaceSnapshot;
  onNavigate: (page: WorkspacePage) => void;
}) {
  return workspace.paper_trading_enabled ? (
    <div className="screen-stack">
      <div>
        <Button onClick={() => onNavigate("Broker paper")}>
          New paper order
        </Button>
      </div>
      <PaperOrdersScreen csrf={workspace.csrf} />
    </div>
  ) : (
    <LiveOrdersScreen key={workspace.csrf} />
  );
}
