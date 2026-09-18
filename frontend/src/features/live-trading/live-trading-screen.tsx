"use client";
/** Live execution screen composes explicit order controls and separate read-only account reports. */
import { LiveOrderTicket } from "./live-order-ticket";
import { KotakAccountReports } from "@/components/kotak-account-reports";
/** No order is placed or account armed by opening this screen. */
export function LiveTradingScreen({ csrf }: { csrf: string }) {
  return (
    <>
      <LiveOrderTicket csrf={csrf} />
      <KotakAccountReports csrf={csrf} loadOnMount />
    </>
  );
}
