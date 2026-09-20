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
const PortfolioScreen = dynamic(
  () =>
    import("@/features/portfolio/portfolio-screen").then(
      (module) => module.PortfolioScreen,
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
  return (
    <section
      className="screen-loading"
      role="status"
      aria-label="Loading screen"
    >
      <p>Loading screen…</p>
      <div aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}
const WatchlistsScreen = dynamic(
  () =>
    import("@/features/watchlists/watchlists-screen").then(
      (module) => module.WatchlistsScreen,
    ),
  { loading: ScreenLoading },
);
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
/** Load the dedicated spread screen only when selected. */
const SpreadBuilderScreen = dynamic(
  () =>
    import("@/features/spread-builder/spread-builder-screen").then(
      (module) => module.SpreadBuilderScreen,
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
  researchStrategyId,
  onOpenStrategy,
  templateId,
  onConfigureTemplate,
  spreadDraft,
  onAddSpreadLeg,
  spreadContext,
  onOpenBuilder,
}: {
  page: WorkspacePage;
  workspace: WorkspaceSnapshot;
  onNavigate: (page: WorkspacePage) => void;
  onRefresh: () => Promise<void>;
  onExploreOptionChain: () => void;
  researchStrategyId: string;
  onOpenStrategy: (id: string, market: "cash" | "options") => void;
  templateId: TemplateId;
  onConfigureTemplate: (id: TemplateId) => void;
  spreadDraft?: ResearchDraft;
  onAddSpreadLeg: (contract: ChainContract, side: "buy" | "sell") => string;
  spreadContext?: {
    underlying: string;
    expiry?: string;
    day?: string;
    spot?: number;
  };
  onOpenBuilder: (selection: {
    underlying: string;
    expiry?: string;
    day?: string;
    spot?: number;
  }) => void;
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
    case "Portfolio":
      return <PortfolioScreen csrf={workspace.csrf} />;
    case "Watchlists":
      return <WatchlistsScreen csrf={workspace.csrf} />;
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
          key={templateId}
          csrf={workspace.csrf}
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
    case "Spread builder":
      return (
        <SpreadBuilderScreen
          csrf={workspace.csrf}
          draft={spreadDraft}
          initialSelection={spreadContext}
        />
      );
    case "Option chain":
      return (
        <OptionChainScreen
          csrf={workspace.csrf}
          legCount={spreadDraft?.definition.legs.length ?? 0}
          onAddLeg={onAddSpreadLeg}
          onOpenBuilder={onOpenBuilder}
        />
      );
    case "Orders & trades":
      return <OrdersScreen csrf={workspace.csrf} />;
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
      return <ActivityScreen workspace={workspace} onRefresh={onRefresh} />;
    case "Learn the stack":
      return <LearningScreen />;
  }
}
