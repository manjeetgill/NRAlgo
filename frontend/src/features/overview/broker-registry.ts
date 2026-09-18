import type { BrokerAccountAdapter } from "@/features/overview/overview-types";
import { kotakAccountAdapter } from "@/features/overview/providers/kotak-account-adapter";

/** Only implemented brokers are selectable. No placeholder connections or synthetic balances. */
export const availableBrokers: readonly BrokerAccountAdapter[] = [
  kotakAccountAdapter,
];
