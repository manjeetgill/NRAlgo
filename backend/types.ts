export type SymbolCode = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
export interface Owner { id: number; username: string; password_hash: string; failed_logins: number; locked_until: number }
export interface LoginSession { token_hash: string; csrf: string; expires: number }
export interface Settings { id: number; halted: boolean | number }
export interface Strategy { id: string; name: string; symbol: SymbolCode; fast: number; slow: number; capital: number; status: string; pnl: number; created_at: string }
export interface Job { id: string; strategy_id: string; status: string; result: string; created_at: string; updated_at: string }
export interface Trade { bar: number; side: 'BUY' | 'SELL'; price: number; quantity: number; pnl: number | null }
export interface ReplayResult { pnl: number; drawdown: number; equity: number[]; trades: Trade[]; bars: number; source: 'synthetic'; risk_stopped: boolean; cost_model: string }
