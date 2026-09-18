"use client";
/** Broker connection and explicitly opened read-only reports; no execution ticket is mounted. */
import { useRef, useState, type FormEvent } from "react";
import { brokerConnectionAdapters } from "@/features/brokers/broker-connection-adapter";
import { useBrokerConnection } from "@/features/brokers/use-broker-connection";
import { Button } from "@/components/ui/button";
import dynamic from "next/dynamic";
/** Broker reports are an explicit, separately loaded read-only tool; connecting never fetches them. */
const BrokerPortfolioPanel = dynamic(() =>
  import("@/components/broker-portfolio-panel").then(
    (module) => module.BrokerPortfolioPanel,
  ),
);

/** Render implemented provider login fields and leave async/session management to the connection hook. */
export function BrokersScreen({ csrf }: { csrf: string }) {
  const adapter = brokerConnectionAdapters[0];
  const connection = useBrokerConnection(adapter, csrf);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [showPortfolio, setShowPortfolio] = useState(false);
  const connectDialog = useRef<HTMLDialogElement>(null);
  const disconnectDialog = useRef<HTMLDialogElement>(null);

  /** Submit credentials once, then erase all input values even after a failed broker response. */
  async function onConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (await connection.changeConnection(credentials)) {
        connectDialog.current?.close();
      }
    } finally {
      setCredentials({});
    }
  }
  /** Explicitly release authentication; the hook handles errors without a blind retry. */
  function onDisconnect() {
    disconnectDialog.current?.showModal();
  }

  return (
    <section className="screen-stack" aria-label="Broker connection">
      <article className="panel screen-card">
        <div className="screen-toolbar">
          <h2>{adapter.name}</h2>
          <span className="badge">
            {connection.connected === null
              ? "Unknown"
              : connection.connected
                ? "Connected"
                : "Not connected"}
          </span>
        </div>
        <p>
          {adapter.name} · Connect your account for market data and account
          access.
        </p>
        <p>
          Connecting does not enable order submission. Live authorization
          remains a separate step.
        </p>
        <p role="status">
          {connection.connected === null
            ? "Connection status unknown"
            : connection.connected
              ? "Connected"
              : "Not connected"}
        </p>
        {connection.error && <p role="alert">{connection.error}</p>}
        <dl className="broker-connection-facts">
          <dt>Account</dt>
          <dd>
            {connection.connected
              ? "Authenticated server session · identifier not exposed"
              : "No verified session"}
          </dd>
          <dt>Capabilities</dt>
          <dd>
            Market quotes, historical candles and account reads. Execution
            requires separate live authorization.
          </dd>
          <dt>Last checked (IST)</dt>
          <dd>
            {connection.checkedAt
              ? new Date(connection.checkedAt).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                })
              : "—"}
          </dd>
        </dl>
        <div className="screen-toolbar">
          <Button
            variant="secondary"
            disabled={connection.busy}
            onClick={() => void connection.refreshStatus()}
          >
            Check session
          </Button>
          <Button
            disabled={connection.busy}
            onClick={() => connectDialog.current?.showModal()}
          >
            {connection.connected ? "Reconnect" : "Connect broker"}
          </Button>
          {connection.connected && (
            <Button
              variant="secondary"
              disabled={connection.busy}
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          )}
        </div>
        <p>
          Session checks report server connection state; they do not place an
          order or verify every market-data permission.
        </p>
        <Button
          variant="secondary"
          disabled={!connection.connected}
          onClick={() => setShowPortfolio(!showPortfolio)}
        >
          {showPortfolio ? "Hide broker portfolio" : "View broker portfolio"}
        </Button>
      </article>
      {showPortfolio && connection.connected && (
        <BrokerPortfolioPanel broker="kotak" csrf={csrf} />
      )}
      <article className="panel screen-card">
        <h2>Connection health and execution permission are separate</h2>
        <p>
          Connecting a broker does not arm trading. Use Live positions to review
          account restrictions, risk limits and authorization before submitting
          an order.
        </p>
      </article>
      <dialog
        ref={connectDialog}
        className="workspace-dialog"
        aria-labelledby="connect-broker-title"
        onClose={() => setCredentials({})}
      >
        <div className="screen-toolbar">
          <h2 id="connect-broker-title">Connect {adapter.name}</h2>
          <Button
            variant="secondary"
            disabled={connection.busy}
            onClick={() => connectDialog.current?.close()}
          >
            Close connection form
          </Button>
        </div>
        {connection.error && (
          <p role="alert" className="error">
            {connection.error}
          </p>
        )}
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
            Credentials are not saved. Reconnect after logout or a server
            restart.
          </p>
          <Button type="submit" disabled={connection.busy}>
            {connection.busy ? "Please wait…" : `Connect ${adapter.name}`}
          </Button>
        </form>
      </dialog>
      <dialog
        ref={disconnectDialog}
        className="workspace-dialog"
        aria-labelledby="disconnect-broker-title"
      >
        <h2 id="disconnect-broker-title">Disconnect {adapter.name}?</h2>
        <p>
          This closes the server-side broker connection and interrupts market
          data. It does not close exchange positions. Resolve any active order
          uncertainty in the broker platform first.
        </p>
        {connection.error && <p role="alert">{connection.error}</p>}
        <Button
          variant="danger"
          disabled={connection.busy}
          onClick={async () => {
            if (await connection.changeConnection()) {
              disconnectDialog.current?.close();
            }
          }}
        >
          Confirm disconnect
        </Button>
        <Button
          variant="secondary"
          disabled={connection.busy}
          onClick={() => disconnectDialog.current?.close()}
        >
          Keep connected
        </Button>
      </dialog>
    </section>
  );
}
