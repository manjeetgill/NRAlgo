/** Provider-neutral registry of implemented Overview account adapters. */
import type { BrokerAccountAdapter } from "../account-model";
import { kotakAccountAdapter } from "./kotak-account-adapter";
import { zerodhaAccountAdapter } from "./zerodha-account-adapter";

/** A broker appears in Overview only when this adapter and a live registry entry both exist. */
export const brokerAccountAdapters: readonly BrokerAccountAdapter[] = [
  kotakAccountAdapter,
  zerodhaAccountAdapter,
];
