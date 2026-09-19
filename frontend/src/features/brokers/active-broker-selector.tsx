"use client";
/** Active-broker preference UI; connectivity and execution authorization remain separate states. */
import { useMemo } from "react";
import { useBrokerRegistry } from "./use-broker-registry";

const providerNames = { kotak: "Kotak Neo", zerodha: "Zerodha Kite" } as const;

/** Render one owner-scoped radio group for future routing without exposing account identifiers. */
export function ActiveBrokerSelector({
  csrf,
  refreshKey,
}: {
  csrf: string;
  refreshKey: number | null;
}) {
  const registry = useBrokerRegistry(csrf, refreshKey);
  const brokers = useMemo(
    () =>
      [...registry.brokers].sort((left, right) =>
        providerNames[left.provider].localeCompare(
          providerNames[right.provider],
        ),
      ),
    [registry.brokers],
  );

  return (
    <article className="panel screen-card active-broker-card">
      <div className="screen-toolbar">
        <div>
          <h2>Active broker</h2>
          <p>
            New live order intents will use this broker after authorization.
          </p>
        </div>
        <span className="badge" role="status">
          {registry.loading ? "Loading…" : `${brokers.length} registered`}
        </span>
      </div>
      {registry.error && (
        <p role="alert" className="error">
          {registry.error}
        </p>
      )}
      {registry.warning && (
        <p role="status" className="warning">
          {registry.warning}
        </p>
      )}
      {!registry.loading && brokers.length === 0 ? (
        <p>Connect a broker to create an active-broker preference.</p>
      ) : (
        <fieldset
          className="active-broker-options"
          disabled={registry.selecting}
        >
          <legend className="sr-only">Choose active broker</legend>
          {brokers.map((broker) => {
            const connected = broker.status === "connected";
            return (
              <label key={broker.id} className="active-broker-option">
                <input
                  type="radio"
                  name="active-broker"
                  value={broker.id}
                  checked={registry.activeBrokerId === broker.id}
                  disabled={!connected || registry.selecting}
                  onChange={() => void registry.select(broker.id)}
                />
                <span>
                  <strong>{providerNames[broker.provider]}</strong>
                  <small>
                    {connected
                      ? "Connected"
                      : "Disconnected · reconnect to select"}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      <p>
        Changing this preference never moves existing broker orders or
        positions. Live trading permission is controlled separately.
      </p>
    </article>
  );
}
