"use client";
/** Authentication-only broker screen: no virtual cash, simulated orders or execution ticket is mounted. */
import { useState, type FormEvent } from "react";
import { brokerConnectionAdapters } from "@/features/brokers/broker-connection-adapter";
import { useBrokerConnection } from "@/features/brokers/use-broker-connection";
import { Button } from "@/components/ui/button";

/** Render implemented provider login fields and leave async/session management to the connection hook. */
export function BrokersScreen({ csrf }: { csrf: string }) {
  const adapter = brokerConnectionAdapters[0];
  const connection = useBrokerConnection(adapter, csrf);
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  /** Submit credentials once, then erase all input values even after a failed broker response. */
  async function onConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await connection.changeConnection(credentials);
    } finally {
      setCredentials({});
    }
  }
  /** Explicitly release authentication; the hook handles errors without a blind retry. */
  function onDisconnect() {
    void connection.changeConnection();
  }

  return (
    <section className="research-panel" aria-label="Broker connection">
      <h2>Broker connection</h2>
      <p>
        {adapter.name} · Connect your account for market data and account
        access.
      </p>
      <p>
        Connecting does not enable order submission. Live authorization remains
        a separate step.
      </p>
      <p role="status">
        {connection.connected === null
          ? "Connection status unknown"
          : connection.connected
            ? "Connected"
            : "Not connected"}
      </p>
      {connection.error && <p role="alert">{connection.error}</p>}
      <form onSubmit={onConnect} autoComplete="off">
        <div className="paper-grid">
          {adapter.fields.map(
            /** Render provider-owned fields without hard-coding them into the hook. */ (
              field,
            ) => (
              <label key={field.name}>
                {field.label}
                <input
                  type={field.type}
                  required
                  disabled={connection.busy}
                  autoComplete="off"
                  value={credentials[field.name] ?? ""}
                  onChange={
                    /** Update only the edited field in transient component memory. */ (
                      event,
                    ) =>
                      setCredentials({
                        ...credentials,
                        [field.name]: event.target.value,
                      })
                  }
                />
              </label>
            ),
          )}
        </div>
        <p>
          Credentials are not saved. Reconnect after logout or a server restart.
        </p>
        <Button type="submit" disabled={connection.busy}>
          {connection.busy ? "Please wait…" : `Connect ${adapter.name}`}
        </Button>
        {connection.connected === true && (
          <Button
            type="button"
            variant="secondary"
            disabled={connection.busy}
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        )}
      </form>
    </section>
  );
}
