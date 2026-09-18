/** Provider-owned login metadata. The shared form/hook never loads a trading wallet. */
import { requestApiJson } from "../../lib/api";

/** Extensible connection contract; credentials stay in memory and are never persisted by the browser. */
export interface BrokerConnectionAdapter {
  id: string;
  name: string;
  fields: readonly { name: string; label: string; type: "text" | "password" }[];
  loadStatus(): Promise<boolean>;
  connect(credentials: Record<string, string>, csrf: string): Promise<unknown>;
  disconnect(csrf: string): Promise<unknown>;
}

/** Only Kotak is implemented. Additional providers supply their own fields and API normalization here. */
export const brokerConnectionAdapters: readonly BrokerConnectionAdapter[] = [
  {
    id: "kotak",
    name: "Kotak Neo",
    fields: [
      { name: "accessToken", label: "API access token", type: "password" },
      { name: "mobileNumber", label: "Mobile (+91…)", type: "text" },
      { name: "ucc", label: "Client code (UCC)", type: "text" },
      { name: "totp", label: "Authenticator TOTP", type: "password" },
      { name: "mpin", label: "MPIN", type: "password" },
    ],
    /** GET reads the owner/session-scoped connection flag without creating a virtual ledger. */
    async loadStatus() {
      const response = await requestApiJson("/brokers/kotak/status");
      if (typeof response.connected !== "boolean") {
        throw new Error("Broker connection status is unavailable.");
      }
      return response.connected;
    },
    /** POST authenticates with the broker; CSRF is required and no orders are submitted or armed. */
    connect(credentials, csrf) {
      return requestApiJson(
        "/brokers/kotak/connect",
        "POST",
        credentials,
        csrf,
        95000,
      );
    },
    /** DELETE drops this user's in-memory broker session; the caller must explicitly request it. */
    disconnect(csrf) {
      return requestApiJson(
        "/brokers/kotak/connect",
        "DELETE",
        undefined,
        csrf,
      );
    },
  },
];
