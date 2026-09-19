"use client";
/** Read broker order and trade records. */
import { LiveOrdersScreen } from "./live-orders-screen";
export function OrdersScreen({ csrf }: { csrf: string }) {
  return <LiveOrdersScreen key={csrf} />;
}
