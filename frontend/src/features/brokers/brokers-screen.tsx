"use client";
/**
 * Broker connection views: active-provider selection, Kotak credential dialog and Zerodha setup.
 * Private views share the connection hooks; portfolio reports remain lazy and read-only.
 * This screen never mounts an execution ticket or submits a broker order.
 */
import { useMemo, useState, type FormEvent } from "react";
import {
  brokerConnectionAdapters,
  useBrokerConnection,
  useBrokerRegistry,
  useZerodhaConnection,
} from "./broker-hooks";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog, DialogActions } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import dynamic from "next/dynamic";

/** Broker reports are an explicit, separately loaded read-only tool; connecting never fetches them. */
const BrokerPortfolioPanel = dynamic(() =>
  import("@/components/broker-portfolio-panel").then(
    (module) => module.BrokerPortfolioPanel,
  ),
);

interface CapabilityRow {
  id: string;
  broker: string;
  reports: string;
  marketData: string;
  execution: string;
}
/** Static, informational comparison; never derived from a live connection response. */
const capabilityRows: CapabilityRow[] = [
  {
    id: "kotak",
    broker: "Kotak Neo",
    reports: "Holdings, positions and funds",
    marketData: "Requires a valid connection",
    execution: "Separate live authorization and risk checks",
  },
  {
    id: "zerodha",
    broker: "Zerodha Kite",
    reports: "Read-only portfolio",
    marketData: "Not integrated",
    execution: "Not available in this app",
  },
];
const capabilityColumns: DataTableColumn<CapabilityRow>[] = [
  { key: "broker", header: "Broker", render: (row) => row.broker },
  {
    key: "reports",
    header: "Account reports",
    render: (row) => row.reports,
  },
  {
    key: "marketData",
    header: "Live market data",
    render: (row) => row.marketData,
  },
  {
    key: "execution",
    header: "Order execution",
    render: (row) => row.execution,
  },
];

/** Render implemented provider login fields and leave async/session management to the connection hook. */
export function BrokersScreen({ csrf }: { csrf: string }) {
  const adapter = brokerConnectionAdapters[0];
  const connection = useBrokerConnection(adapter, csrf);
  const toast = useToast();
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  /** Submit credentials once, then erase all input values even after a failed broker response. */
  async function onConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (await connection.changeConnection(credentials)) {
        setConnectOpen(false);
        toast({ tone: "success", title: `${adapter.name} connected` });
      }
    } finally {
      setCredentials({});
    }
  }

  const connectionBadgeTone: BadgeTone =
    connection.connected === null
      ? "neutral"
      : connection.connected
        ? "success"
        : "warning";

  return (
    <section className="screen-stack" aria-label="Broker connection">
      <ActiveBrokerSelector csrf={csrf} refreshKey={connection.checkedAt} />
      <Card aria-label="Broker capabilities">
        <CardHeader>
          <CardTitle>What each connection supports</CardTitle>
        </CardHeader>
        <DataTable
          columns={capabilityColumns}
          rows={capabilityRows}
          rowKey={(row) => row.id}
        />
        <p className="muted" style={{ marginTop: "var(--space-4)" }}>
          Connect authorizes access. Verify session only checks the connection.
          Neither action starts trading.
        </p>
      </Card>
      <div className="screen-two-columns broker-cards">
        <Card>
          <div className="screen-toolbar">
            <h2 className="broker-card-title">
              <span className="connection-logo">K</span>
              {adapter.name}
            </h2>
            <Badge tone={connectionBadgeTone}>
              {connection.connected === null
                ? "Unknown"
                : connection.connected
                  ? "Connected"
                  : "Authorization required"}
            </Badge>
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
              onClick={() => setConnectOpen(true)}
            >
              {connection.connected ? "Reconnect" : "Connect broker"}
            </Button>
            {connection.connected && (
              <Button
                variant="secondary"
                disabled={connection.busy}
                onClick={() => setDisconnectOpen(true)}
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
        </Card>
        <ZerodhaConnectionCard csrf={csrf} />
      </div>
      {showPortfolio && connection.connected && (
        <BrokerPortfolioPanel broker="kotak" csrf={csrf} />
      )}
      <Card>
        <CardTitle>
          Connection health and execution permission are separate
        </CardTitle>
        <p style={{ marginTop: "var(--space-2)" }}>
          Connecting a broker does not arm trading. Use Live positions to review
          account restrictions, risk limits and authorization before submitting
          an order.
        </p>
      </Card>
      <Dialog
        open={connectOpen}
        onClose={() => {
          setConnectOpen(false);
          setCredentials({});
        }}
        title={`Connect ${adapter.name}`}
        labelledBy="connect-broker-title"
      >
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
                <Field
                  key={field.name}
                  label={field.label}
                  htmlFor={`connect-${field.name}`}
                >
                  <Input
                    id={`connect-${field.name}`}
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
                </Field>
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
      </Dialog>
      <Dialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title={`Disconnect ${adapter.name}?`}
        labelledBy="disconnect-broker-title"
      >
        <p>
          This closes the server-side broker connection and interrupts market
          data. It does not close exchange positions. Resolve any active order
          uncertainty in the broker platform first.
        </p>
        {connection.error && <p role="alert">{connection.error}</p>}
        <DialogActions>
          <Button
            variant="secondary"
            disabled={connection.busy}
            onClick={() => setDisconnectOpen(false)}
          >
            Keep connected
          </Button>
          <Button
            variant="danger"
            disabled={connection.busy}
            onClick={async () => {
              if (await connection.changeConnection()) {
                setDisconnectOpen(false);
                toast({
                  tone: "success",
                  title: `${adapter.name} disconnected`,
                });
              }
            }}
          >
            Confirm disconnect
          </Button>
        </DialogActions>
      </Dialog>
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
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
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
  /** Never dismiss while a selection request is in flight; mirrors the previous native dialog guard. */
  function closeConfirmation() {
    if (registry.selecting) {
      return;
    }
    setConfirmOpen(false);
    setPendingBrokerId(null);
    setBrokerProof("");
  }

  return (
    <Card className="active-broker-card">
      <div className="screen-toolbar">
        <div>
          <h2>Active live broker</h2>
          <p>
            Select the account for supported live activity. Only Kotak Neo
            currently supports order execution in this app.
          </p>
        </div>
        <Badge tone="accent" role="status">
          {registry.loading ? "Loading…" : `${brokers.length} registered`}
        </Badge>
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
                    setConfirmOpen(true);
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
      <Dialog
        open={confirmOpen}
        onClose={closeConfirmation}
        title={`Use ${
          pendingBroker ? providerNames[pendingBroker.provider] : "this broker"
        } as your live broker?`}
        labelledBy="active-live-broker-title"
      >
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
        <Field
          label="Fresh authenticator or unused recovery code"
          htmlFor="active-broker-proof"
        >
          <Input
            id="active-broker-proof"
            type="password"
            autoComplete="one-time-code"
            maxLength={32}
            value={brokerProof}
            disabled={registry.selecting}
            onChange={(event) => setBrokerProof(event.target.value)}
          />
        </Field>
        <p>
          Set up MFA in Account &amp; security first. Changing broker clears
          live trading permission. Starting live trading requires a new code;
          wait for the next code if you just used one.
        </p>
        <DialogActions>
          <Button
            variant="secondary"
            disabled={registry.selecting}
            onClick={closeConfirmation}
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
                  setConfirmOpen(false);
                  toast({ tone: "success", title: "Active broker updated" });
                }
              } finally {
                setBrokerProof("");
              }
            }}
          >
            {registry.selecting ? "Changing…" : "Confirm live broker"}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

/** Redirect authorization and setup view; credentials exist only in transient form state. */
function ZerodhaConnectionCard({ csrf }: { csrf: string }) {
  const toast = useToast();
  const [setupOpen, setSetupOpen] = useState(false);
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
        setSetupOpen(false);
        toast({ tone: "success", title: "Zerodha credentials saved" });
      }
    } finally {
      setAppCredentials({ apiKey: "", apiSecret: "" });
    }
  }
  const zerodhaBadgeTone: BadgeTone = !connection
    ? "neutral"
    : connection.connected
      ? "success"
      : connection.configured
        ? "warning"
        : "neutral";
  async function runAction(kind: "login" | "verify" | "disconnect") {
    await action(kind);
    if (kind === "verify") {
      toast({ tone: "success", title: "Zerodha session verified" });
    } else if (kind === "disconnect") {
      toast({ tone: "success", title: "Zerodha disconnected" });
    }
  }
  return (
    <>
      <Card aria-label="Zerodha connection">
        <div className="screen-toolbar">
          <h2 className="broker-card-title">
            <span className="connection-logo">Z</span>Zerodha Kite
          </h2>
          <Badge tone={zerodhaBadgeTone} role="status">
            {!connection
              ? "Checking connection…"
              : connection.connected
                ? "Authorized · connected"
                : connection.configured
                  ? "Ready to authorize"
                  : "Setup required"}
          </Badge>
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
            onClick={() => void runAction("login")}
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
            onClick={() => void runAction("verify")}
          >
            Verify Zerodha session
          </Button>
          {connection?.connected && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void runAction("disconnect")}
            >
              Disconnect Zerodha
            </Button>
          )}
          <Button variant="secondary" onClick={() => setSetupOpen(true)}>
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
      </Card>
      <Dialog
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
          setAppCredentials({ apiKey: "", apiSecret: "" });
        }}
        title="Set up Zerodha Kite"
        labelledBy="zerodha-setup-title"
      >
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
            <Field label="Zerodha API key" htmlFor="zerodha-api-key">
              <Input
                id="zerodha-api-key"
                required
                minLength={8}
                maxLength={64}
                pattern="[A-Za-z0-9_\-]+"
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
            </Field>
            <Field label="Zerodha API secret" htmlFor="zerodha-api-secret">
              <Input
                id="zerodha-api-secret"
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
            </Field>
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
      </Dialog>
    </>
  );
}
