/** Presentation-only tour. Steps never call trading or account mutation APIs. */
import type { WorkspacePage } from "./workspace-types";

export const workspaceTour: ReadonlyArray<{
  page: WorkspacePage;
  title: string;
  description: string;
}> = [
  {
    page: "Overview",
    title: "Your workspace at a glance",
    description: "Review account health, recent activity and quick actions.",
  },
  {
    page: "Option chain",
    title: "Explore the option chain",
    description: "Inspect a call or put, then add a leg to your spread draft.",
  },
  {
    page: "Spread builder",
    title: "Build and review a spread",
    description:
      "Review selected legs and the payoff before considering execution.",
  },
  {
    page: "Broker paper",
    title: "Review a paper order",
    description:
      "Use New order to review an order for the separate virtual ledger. The tour submits nothing.",
  },
  {
    page: "Orders & trades",
    title: "Follow the result",
    description:
      "Open Details to inspect the recorded order history, or filter the records.",
  },
  {
    page: "Activity log",
    title: "Close with the audit trail",
    description:
      "Review the actions recorded in your account. Search and export the loaded events.",
  },
];
