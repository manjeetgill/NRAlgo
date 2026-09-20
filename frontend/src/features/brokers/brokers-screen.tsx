"use client";
/**
 * Broker connection views: active-provider selection, Kotak credential dialog and Zerodha setup.
 * Private views share the connection hooks; portfolio reports remain lazy and read-only.
 * This screen never mounts an execution ticket or submits a broker order.
 */
import { useMemo, useRef, useState, type FormEvent } from "react";
import {
  brokerConnectionAdapters,
  useBrokerConnection,
  useBrokerRegistry,
  useZerodhaConnection,
} from "./broker-hooks";
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
      <ActiveBrokerSelector csrf={csrf} refreshKey={connection.checkedAt} />
      <section className="panel screen-card" aria-label="Broker capabilities">
        <h2>What each connection supports</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Broker</th>
                <th>Account reports</th>
                <th>Live market data</th>
                <th>Order execution</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Kotak Neo</th>
                <td>Holdings, positions and funds</td>
                <td>Requires a valid connection</td>
                <td>Separate live authorization and risk checks</td>
              </tr>
              <tr>
                <th scope="row">Zerodha Kite</th>
                <td>Read-only portfolio</td>
                <td>Not integrated</td>
                <td>Not available in this app</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Connect authorizes access. Verify session only checks the connection.
          Neither action starts trading.
        </p>
      </section>
      <div className="screen-two-columns broker-cards">
        <article className="panel screen-card">
          <div className="screen-toolbar">
            <h2 className="broker-card-title">
              <span className="connection-logo">K</span>
              {adapter.name}
            </h2>
            <span className="badge">
              {connection.connected === null
                ? "Unknown"
                : connection.connected
                  ? "Connected"
                  : "Authorization required"}
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
                : "Authorize to use live broker data. Historical data remains available."}
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
          {connection.connected && connection.expiresAt && (
            <p>
              Session valid until{" "}
              {new Date(connection.expiresAt).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
              })}{" "}
              IST, unless revoked earlier.
            </p>
          )}
          <div className="screen-toolbar">
            <Button
              variant="secondary"
              disabled={connection.busy}
              onClick={() => void connection.refreshStatus()}
            >
              Verify session
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
        <ZerodhaConnectionCard csrf={csrf} />
      </div>
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
          <div className="market-grid">
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
            Passwords, MPIN and TOTP are never saved. Session tokens are
            encrypted on the server and verified after a restart. Authorize
            again after logout or expiry.
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

const providerNames = { kotak: "Kotak Neo", zerodha: "Zerodha Kite" } as const;

/** Render one owner-scoped radio group for future routing without exposing account identifiers. */
function ActiveBrokerSelector({
  csrf,
  refreshKey,
}: {
  csrf: string;
  refreshKey: number | null;
}) {
  const registry = useBrokerRegistry(csrf, refreshKey);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const [pendingBrokerId, setPendingBrokerId] = useState<string | null>(null);
  const [brokerProof, setBrokerProof] = useState("");
  const pendingBroker = registry.brokers.find(
    (broker) => broker.id === pendingBrokerId,
  );
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
          <h2>Active live broker</h2>
          <p>
            Select the account for supported live activity. Only Kotak Neo
            currently supports order execution in this app.
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
                  onChange={() => {
                    setPendingBrokerId(broker.id);
                    confirmationDialog.current?.showModal();
                  }}
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
      <dialog
        ref={confirmationDialog}
        className="workspace-dialog"
        aria-labelledby="active-live-broker-title"
        aria-describedby="active-live-broker-description"
        onCancel={(event) => {
          if (registry.selecting) {
            event.preventDefault();
          }
        }}
        onClose={() => {
          setPendingBrokerId(null);
          setBrokerProof("");
        }}
      >
        <h2 id="active-live-broker-title">
          Use{" "}
          {pendingBroker
            ? providerNames[pendingBroker.provider]
            : "this broker"}{" "}
          as your live broker?
        </h2>
        <p id="active-live-broker-description">
          This selects your connected{" "}
          {pendingBroker ? providerNames[pendingBroker.provider] : "broker"}{" "}
          account for future live market activity, including supported live data
          and new live trades. Live order submission still requires separate
          authorization.
        </p>
        <p>
          Existing orders and positions remain with their original broker. They
          are not moved or closed. Unsupported activity is blocked, never routed
          automatically to another broker.
        </p>
        {pendingBroker?.provider === "zerodha" && (
          <p role="note">
            Zerodha live order execution is not yet available in this app.
          </p>
        )}
        {registry.error && <p role="alert">{registry.error}</p>}
        <label>
          Fresh authenticator or unused recovery code
          <input
            type="password"
            autoComplete="one-time-code"
            maxLength={32}
            value={brokerProof}
            disabled={registry.selecting}
            onChange={(event) => setBrokerProof(event.target.value)}
          />
        </label>
        <p>
          Set up MFA in Account &amp; security first. Changing broker clears
          live trading permission. Starting live trading requires a new code;
          wait for the next code if you just used one.
        </p>
        <div className="screen-toolbar">
          <Button
            variant="secondary"
            disabled={registry.selecting}
            onClick={() => confirmationDialog.current?.close()}
          >
            Cancel
          </Button>
          <Button
            disabled={
              registry.selecting ||
              pendingBroker?.status !== "connected" ||
              !brokerProof.trim()
            }
            onClick={async () => {
              try {
                if (
                  pendingBroker &&
                  (await registry.select(pendingBroker.id, brokerProof.trim()))
                ) {
                  confirmationDialog.current?.close();
                }
              } finally {
                setBrokerProof("");
              }
            }}
          >
            {registry.selecting ? "Changing…" : "Confirm live broker"}
          </Button>
        </div>
      </dialog>
    </article>
  );
}

/** Redirect authorization and setup view; credentials exist only in transient form state. */
function ZerodhaConnectionCard({ csrf }: { csrf: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { connection, busy, error, action, configure } =
    useZerodhaConnection(csrf);
  const [appCredentials, setAppCredentials] = useState({
    apiKey: "",
    apiSecret: "",
  });

  /** Submit once to the same-origin API and immediately erase both form values. */
  async function onConfigure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (await configure(appCredentials)) {
        dialog.current?.close();
      }
    } finally {
      setAppCredentials({ apiKey: "", apiSecret: "" });
    }
  }
  return (
    <>
      <article className="panel screen-card" aria-label="Zerodha connection">
        <div className="screen-toolbar">
          <h2 className="broker-card-title">
            <span className="connection-logo">Z</span>Zerodha Kite
          </h2>
          <span className="badge" role="status">
            {!connection
              ? "Checking connection…"
              : connection.connected
                ? "Authorized · connected"
                : connection.configured
                  ? "Ready to authorize"
                  : "Setup required"}
          </span>
        </div>
        <p>
          Authorize this app to access your Zerodha account through Kite APIs.
          Sign in securely on Zerodha, then return here to finish authorization.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {connection?.connected && connection.expiresAt && (
          <p>
            Session valid until{" "}
            {new Date(connection.expiresAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })}{" "}
            IST, unless revoked earlier.
          </p>
        )}
        <dl className="broker-connection-facts">
          <dt>Account</dt>
          <dd>
            {connection?.account
              ? `${connection.account.user_name} · ${connection.account.user_id}`
              : "No verified Zerodha session"}
          </dd>
          <dt>Access</dt>
          <dd>
            Authorized API session, profile verification and read-only portfolio
            snapshots. Market-data screens and order routing are not yet
            integrated with Zerodha.
          </dd>
          <dt>Execution</dt>
          <dd>Disabled · connecting does not authorize trading</dd>
        </dl>
        <div className="screen-toolbar">
          <Button
            disabled={busy || !connection?.configured}
            onClick={() => void action("login")}
          >
            {busy
              ? "Please wait…"
              : connection?.connected
                ? "Reauthorize with Zerodha"
                : "Authorize with Zerodha"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void action("verify")}
          >
            Verify Zerodha session
          </Button>
          {connection?.connected && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void action("disconnect")}
            >
              Disconnect Zerodha
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => dialog.current?.showModal()}
          >
            Set up Zerodha
          </Button>
        </div>
        <p>
          Session tokens are encrypted on the server and verified after a
          restart. Logout, disconnect or expiry requires fresh authorization.
          Disconnect removes this app’s session, not your login on Zerodha’s
          website.
        </p>
        {connection && !connection.configured && (
          <p>
            Configure your Kite app on the server to enable authorization. Open
            Set up Zerodha for instructions.
          </p>
        )}
      </article>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        aria-labelledby="zerodha-setup-title"
        onClose={() => setAppCredentials({ apiKey: "", apiSecret: "" })}
      >
        <div className="screen-toolbar">
          <h2 id="zerodha-setup-title">Set up Zerodha Kite</h2>
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Close Zerodha setup
          </Button>
        </div>
        <ol>
          <li>
            Create an app in the{" "}
            <a
              href="https://developers.kite.trade/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Kite developer portal
            </a>
            .
          </li>
          <li>
            Register this exact redirect URL:
            <p>
              <code>
                {connection?.callbackUrl ??
                  "Start the updated API to load your callback URL."}
              </code>
            </p>
          </li>
          <li>
            Enter the API key and secret from that app below. Saving new
            credentials disconnects any existing Zerodha session, so authorize
            again afterward.
          </li>
          <li>
            Click Authorize with Zerodha, sign in on Zerodha, then click
            Complete authorization when returned to this app.
          </li>
        </ol>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <form onSubmit={onConfigure} autoComplete="off">
          <div className="market-grid">
            <label>
              Zerodha API key
              <input
                required
                minLength={8}
                maxLength={64}
                pattern="[A-Za-z0-9_-]+"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                value={appCredentials.apiKey}
                onChange={(event) =>
                  setAppCredentials((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Zerodha API secret
              <input
                type="password"
                required
                minLength={16}
                maxLength={128}
                autoComplete="new-password"
                disabled={busy}
                value={appCredentials.apiSecret}
                onChange={(event) =>
                  setAppCredentials((current) => ({
                    ...current,
                    apiSecret: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          <p>
            Stored encrypted for this workspace. The secret is never displayed
            again or returned by the API.
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save Zerodha credentials"}
          </Button>
        </form>
        <p>
          No Zerodha password or OTP is collected here. Those are entered only
          on Zerodha during authorization. Your Kotak connection is independent.
        </p>
      </dialog>
    </>
  );
}
