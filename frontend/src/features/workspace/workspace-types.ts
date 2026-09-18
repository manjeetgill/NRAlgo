/** Public workspace contracts. These contain no broker credentials or order-execution capability. */
export type Strategy = {
  id: string;
  name: string;
  symbol: string;
  fast: number;
  slow: number;
  capital: number;
  status: string;
  pnl: number;
};
export type Fill = {
  bar: number;
  side: string;
  price: number;
  quantity: number;
  pnl: number | null;
};
export type Result = {
  pnl?: number;
  drawdown?: number;
  equity?: number[];
  trades?: Fill[];
  cost_model?: string;
};
export type Job = {
  id: string;
  strategy_id: string;
  status: string;
  created_at: string;
  result: Result;
};
export type WorkspaceSnapshot = {
  paper_trading_enabled?: boolean;
  live_submission_enabled?: boolean;
  live_configured?: boolean;
  username: string;
  csrf: string;
  halted: boolean;
  strategies: Strategy[];
  jobs: Job[];
  events: { id: number; message: string; created_at: string }[];
};
export type WorkspacePage =
  | "Market data"
  | "Broker paper"
  | "Strategy lab"
  | "Live trading"
  | "Overview"
  | "Strategies"
  | "Orders & trades"
  | "Brokers"
  | "Account & security"
  | "Activity log"
  | "Learn the stack";

/** Public setup policy displayed before authentication; it is not authorization. */
export interface AuthStatus {
  setup_required: boolean;
  setup_token_required: boolean;
  registration_enabled: boolean;
  invite_required: boolean;
}
