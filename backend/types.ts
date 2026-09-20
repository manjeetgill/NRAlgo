/** Shared backend row/result contracts. These describe data, not authorization;
 * private database reads must still include the authenticated user_id in their SQL predicates.
 */
export interface User {
  id: string;
  username: string;
  password_hash: string;
}
export interface LoginSession {
  token_hash: string;
  csrf: string;
  expires: number;
  user_id: string;
}
export interface Settings {
  id: number;
  halted: boolean | number;
}
export interface Job {
  id: string;
  user_id: string;
  strategy_id: string;
  status: string;
  result: string;
  created_at: string;
  updated_at: string;
}
