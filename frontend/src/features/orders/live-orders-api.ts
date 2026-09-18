/** Broker-neutral view of durable, app-managed live orders. Research jobs are never used as a fallback. */
import { requestApiJson } from "../../lib/api";

export interface LiveOrderRecord {
  id: string;
  state: string;
  intent: {
    instrument: string;
    side: "buy" | "sell";
    quantity: number;
    limitPaise: number;
  };
  brokerOrder?: { brokerOrderId: string; filledQuantity: number } | null;
}

export interface LiveOrdersSnapshot {
  enabled: boolean;
  reason?: string;
  orders?: LiveOrderRecord[];
}

/** Read the existing OMS snapshot once; this GET cannot arm, reconcile, submit, or cancel an order. */
export async function loadLiveOrders(): Promise<LiveOrdersSnapshot> {
  return requestApiJson("/live/status");
}
