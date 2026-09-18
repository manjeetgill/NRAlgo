"use client";
/** Lazy screen boundary: Overview does not eagerly download every trading/research editor. */
import dynamic from "next/dynamic";
import { OverviewScreen } from "@/features/overview/overview-screen";
import type { WorkspacePage, WorkspaceSnapshot } from "./workspace-types";
import type { TemplateId } from "@/features/strategy-library/strategy-templates";
import type { ResearchDraft } from "@/features/research/research-draft";
import type { ChainContract } from "@/components/live-option-chain";
/** Option-chain pricing is shared data, not an order ticket. */
const OptionChainScreen = dynamic(
  () =>
    import("@/features/option-chain/option-chain-screen").then(
      (module) => module.OptionChainScreen,
    ),
  { loading: ScreenLoading },
);
/** Historical calculations have no dependencies on order execution. */
const BacktestStudioScreen = dynamic(
  () =>
    import("@/features/backtest-studio/backtest-studio-screen").then(
      (module) => module.BacktestStudioScreen,
    ),
  { loading: ScreenLoading },
);
/** Accessible fallback while the selected screen's code is fetched. */
function ScreenLoading() {
  return <p role="status">Loading screen…</p>;
}
/** Static imports let Next build independent chunks; named-export callbacks return components, not commands. */
const StrategiesScreen = dynamic(
  () =>
    import("@/features/strategies/strategies-screen").then(
      (module) => module.StrategiesScreen,
    ),
  { loading: ScreenLoading },
);
/** Rule descriptions are separately chunked from calculation and execution features. */
const StrategyLibraryScreen = dynamic(
  () =>
    import("@/features/strategy-library/strategy-library-screen").then(
      (module) => module.StrategyLibraryScreen,
    ),
  { loading: ScreenLoading },
);
const StrategyLabScreen = dynamic(
  () =>
    import("@/features/strategy-lab/strategy-lab-screen").then(
      (module) => module.StrategyLabScreen,
    ),
  { loading: ScreenLoading },
);
const PaperTradingScreen = dynamic(
  () =>
    import("@/features/paper-trading/paper-trading-screen").then(
      (module) => module.PaperTradingScreen,
    ),
  { loading: ScreenLoading },
);
/** Load the dedicated spread screen only when selected. */
const SpreadBuilderScreen = dynamic(
  () =>
    import("@/features/spread-builder/spread-builder-screen").then(
      (module) => module.SpreadBuilderScreen,
    ),
  { loading: ScreenLoading },
);
const MarketDataScreen = dynamic(
  () =>
    import("@/features/market-data/market-data-screen").then(
      (module) => module.MarketDataScreen,
    ),
  { loading: ScreenLoading },
);
const OrdersScreen = dynamic(
  () =>
    import("@/features/orders/orders-screen").then(
      (module) => module.OrdersScreen,
    ),
  { loading: ScreenLoading },
);
const BrokersScreen = dynamic(
  () =>
    import("@/features/brokers/brokers-screen").then(
      (module) => module.BrokersScreen,
    ),
  { loading: ScreenLoading },
);
const LiveTradingScreen = dynamic(
  () =>
    import("@/features/live-trading/live-trading-screen").then(
      (module) => module.LiveTradingScreen,
    ),
  { loading: ScreenLoading },
);
const AccountScreen = dynamic(
  () =>
    import("@/features/account/account-screen").then(
      (module) => module.AccountScreen,
    ),
  { loading: ScreenLoading },
);
const ActivityScreen = dynamic(
  () =>
    import("@/features/activity/activity-screen").then(
      (module) => module.ActivityScreen,
    ),
  { loading: ScreenLoading },
);
const LearningScreen = dynamic(
  () =>
    import("@/features/learning/learning-screen").then(
      (module) => module.LearningScreen,
    ),
  { loading: ScreenLoading },
);
/** Resolve only presentation components; the dispatcher cannot submit orders or read another account. */
export function WorkspaceContent({
  page,
  workspace,
  onNavigate,
  onRefresh,
  onExploreOptionChain,
  marketInitialTool,
  researchStrategyId,
  onOpenStrategy,
  templateId,
  onConfigureTemplate,
  spreadDraft,
  onDraftChange,
  onAddSpreadLeg,
}: {
  page: WorkspacePage;
  workspace: WorkspaceSnapshot;
  onNavigate: (page: WorkspacePage) => void;
  onRefresh: () => Promise<void>;
  onExploreOptionChain: () => void;
  marketInitialTool: "quotes" | "chain";
  researchStrategyId: string;
  onOpenStrategy: (id: string, market: "cash" | "options") => void;
  templateId: TemplateId;
  onConfigureTemplate: (id: TemplateId) => void;
  spreadDraft?: ResearchDraft;
  onDraftChange: (draft: ResearchDraft) => void;
  onAddSpreadLeg: (contract: ChainContract, side: "buy" | "sell") => string;
}) {
  switch (page) {
    case "Overview":
      return (
        <OverviewScreen
          workspace={workspace}
          onNavigate={onNavigate}
          onExploreOptionChain={onExploreOptionChain}
        />
      );
    case "Strategies":
      return (
        <StrategiesScreen
          csrf={workspace.csrf}
          onOpenStrategy={onOpenStrategy}
        />
      );
    case "Strategy library":
      return <StrategyLibraryScreen onConfigure={onConfigureTemplate} />;
    case "Backtest studio":
      return (
        <BacktestStudioScreen
          csrf={workspace.csrf}
          key={templateId}
          templateId={templateId}
          onBrowse={() => onNavigate("Strategy library")}
        />
      );
    case "Strategy lab":
      return (
        <StrategyLabScreen
          csrf={workspace.csrf}
          initialStrategyId={researchStrategyId}
        />
      );
    case "Broker paper":
      return <PaperTradingScreen csrf={workspace.csrf} />;
    case "Spread builder":
      return (
        <SpreadBuilderScreen
          csrf={workspace.csrf}
          initialStrategyId={researchStrategyId}
          draft={spreadDraft}
          onDraftChange={onDraftChange}
        />
      );
    case "Option chain":
      return (
        <OptionChainScreen
          csrf={workspace.csrf}
          legCount={spreadDraft?.definition.legs.length ?? 0}
          onAddLeg={onAddSpreadLeg}
          onOpenBuilder={() => onNavigate("Spread builder")}
        />
      );
    case "Market data":
      return (
        <MarketDataScreen
          csrf={workspace.csrf}
          initialTool={marketInitialTool}
        />
      );
    case "Orders & trades":
      return <OrdersScreen workspace={workspace} onNavigate={onNavigate} />;
    case "Brokers":
      return <BrokersScreen csrf={workspace.csrf} />;
    case "Live trading":
      return <LiveTradingScreen csrf={workspace.csrf} />;
    case "Account & security":
      return (
        <AccountScreen
          csrf={workspace.csrf}
          username={workspace.username}
          onRefresh={onRefresh}
        />
      );
    case "Activity log":
      return (
        <ActivityScreen
          workspace={workspace}
          onRefresh={onRefresh}
          tradingMode={workspace.paper_trading_enabled ? "paper" : "live"}
        />
      );
    case "Learn the stack":
      return <LearningScreen />;
  }
}
