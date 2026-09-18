/** One selected-account read; kept outside React so mode isolation can be tested with fake adapters. */
import type {
  AccountMode,
  AccountSnapshot,
  BrokerAccountAdapter,
} from "@/features/overview/overview-types";

/** Fetch only the active mode. Live reads authentication first and never call the virtual-wallet API. */
export async function loadOverviewSnapshot(
  broker: BrokerAccountAdapter,
  csrf: string,
  mode: AccountMode,
): Promise<{ connected: boolean; snapshot: AccountSnapshot | null }> {
  if (mode === "paper") {
    // Adapter API: load virtual funds only when explicitly configured for this workspace.
    return broker.loadPaperAccount();
  }
  // Adapter APIs: authentication and one broker snapshot, with no automatic order submission.
  const connected = await broker.loadConnectionStatus();
  return {
    connected,
    snapshot: connected ? await broker.loadLiveAccount(csrf) : null,
  };
}
