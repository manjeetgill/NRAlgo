"use client";
/**
 * Broker connection views: active-provider selection, Kotak credential dialog and Zerodha setup.
 * Private views share the connection hooks; portfolio reports remain lazy and read-only.
 * Connected execution-capable brokers expose the shared authorization control; order entry
 * remains on the dedicated trading screens and every permission is enforced by the server.
 */
import { useMemo, useState, type FormEvent } from "react";
import {
  brokerConnectionAdapters,
  useBrokerConnection,
  useBrokerRegistry,
  useIciciConnection,
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

/** Load the guarded authorization UI only after a connected broker action opens it. */
const LiveOrderTicket = dynamic(() =>
  import("@/features/live-trading/live-order-ticket").then(
    (module) => module.LiveOrderTicket,
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
    marketData:
      "Quote snapshots require Kite data access; no live chart stream",
    execution: "Separate live authorization and risk checks",
  },
  {
    id: "icici",
    broker: "ICICI Direct Breeze",
    reports: "NSE/NFO holdings, positions and funds",
    marketData: "NSE/NFO only; Breeze does not expose MCX",
    execution:
      "Connection and portfolio adapter; live execution remains locked",
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
  const [liveProvider, setLiveProvider] = useState<"kotak" | "zerodha" | null>(
    null,
  );
  const liveRegistry = useBrokerRegistry(csrf, connection.checkedAt);
  const liveBroker = liveRegistry.brokers.find(
    (broker) => broker.provider === liveProvider,
  );

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
              <>
                <Button
                  disabled={connection.busy}
                  onClick={() => setLiveProvider("kotak")}
                >
                  Enable live trading…
                </Button>
                <Button
                  variant="secondary"
                  disabled={connection.busy}
                  onClick={() => setDisconnectOpen(true)}
                >
                  Disconnect
                </Button>
              </>
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
        <ZerodhaConnectionCard
          csrf={csrf}
          onOpenLiveAuthorization={() => setLiveProvider("zerodha")}
        />
        <IciciConnectionCard csrf={csrf} />
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
      <Dialog
        open={liveProvider !== null}
        onClose={() => setLiveProvider(null)}
        title={`Authorize ${liveProvider ? providerNames[liveProvider] : "broker"} live trading`}
        labelledBy="broker-live-authorization-title"
        className="broker-live-authorization-dialog"
      >
        {liveProvider && (
          <>
            {liveBroker && liveRegistry.activeBrokerId !== liveBroker.id && (
              <p role="alert" className="warning">
                Select {providerNames[liveProvider]} under Active live broker
                before enabling. Broker selection and five-minute live
                authorization require separate fresh MFA codes.
              </p>
            )}
            <LiveOrderTicket
              csrf={csrf}
              activeBroker={liveBroker}
              brokerStatusUnavailable={Boolean(liveRegistry.error)}
              authorizationOnly
            />
          </>
        )}
      </Dialog>
    </section>
  );
}

const providerNames = {
  kotak: "Kotak Neo",
  zerodha: "Zerodha Kite",
  icici: "ICICI Direct",
} as const;

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
            Select the account for supported activity. Live execution is
            available only where the provider adapter and separate risk
            authorization are both enabled.
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
            Zerodha requires registered static-IP configuration and fresh quote
            access. Switching brokers clears live permission; authorize again in
            Live positions.
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
function ZerodhaConnectionCard({
  csrf,
  onOpenLiveAuthorization,
}: {
  csrf: string;
  onOpenLiveAuthorization: () => void;
}) {
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
            snapshots. Supported live orders use this account only, after server
            configuration, risk checks and fresh app 2FA authorization.
          </dd>
          <dt>Execution</dt>
          <dd>
            Requires separate authorization ·{" "}
            <a href="#/live-positions">Review live trading controls</a>
          </dd>
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
            <>
              <Button disabled={busy} onClick={onOpenLiveAuthorization}>
                Enable live trading…
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void runAction("disconnect")}
              >
                Disconnect Zerodha
              </Button>
            </>
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

/** ICICI Breeze connection card; the daily session key is collected only for explicit login. */
function IciciConnectionCard({ csrf }: { csrf: string }) {
  const toast = useToast();
  const { connection, busy, error, connect, disconnect } =
    useIciciConnection(csrf);
  const [open, setOpen] = useState(false);
  const [credentials, setCredentials] = useState({
    appKey: "",
    secretKey: "",
    sessionKey: "",
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (await connect(credentials)) {
        setOpen(false);
        toast({ tone: "success", title: "ICICI Direct connected" });
      }
    } finally {
      setCredentials({ appKey: "", secretKey: "", sessionKey: "" });
    }
  }
  return (
    <>
      <Card aria-label="ICICI Direct connection">
        <div className="screen-toolbar">
          <h2 className="broker-card-title">
            <span className="connection-logo">I</span>ICICI Direct Breeze
          </h2>
          <Badge tone={connection?.connected ? "success" : "warning"}>
            {connection?.connected ? "Connected" : "Authorization required"}
          </Badge>
        </div>
        <p>
          Connect Breeze for NSE/NFO holdings, positions and funds. Connecting
          does not enable live-order submission.
        </p>
        <p role="note" className="warning">
          ICICI&apos;s Breeze API currently does not expose MCX or BSE
          securities. Commodity positions cannot be imported through this
          adapter.
        </p>
        {connection?.account && (
          <p>
            Connected account: {connection.account.user_name} ·{" "}
            {connection.account.user_id}
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="screen-toolbar">
          <Button disabled={busy} onClick={() => setOpen(true)}>
            {connection?.connected ? "Reconnect ICICI" : "Connect ICICI"}
          </Button>
          {connection?.connected && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                if (await disconnect()) {
                  toast({
                    tone: "success",
                    title: "ICICI Direct disconnected",
                  });
                }
              }}
            >
              Disconnect
            </Button>
          )}
        </div>
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Connect ICICI Direct Breeze"
        labelledBy="connect-icici-title"
      >
        <form onSubmit={submit} autoComplete="off">
          <div className="market-grid">
            {(
              [
                ["appKey", "Breeze API key", "text"],
                ["secretKey", "Breeze secret key", "password"],
                ["sessionKey", "Daily Breeze session key", "password"],
              ] as const
            ).map(([name, label, type]) => (
              <Field key={name} label={label} htmlFor={`icici-${name}`}>
                <Input
                  id={`icici-${name}`}
                  type={type}
                  required
                  minLength={1}
                  maxLength={512}
                  disabled={busy}
                  autoComplete="off"
                  value={credentials[name]}
                  onChange={(event) =>
                    setCredentials((current) => ({
                      ...current,
                      [name]: event.target.value,
                    }))
                  }
                />
              </Field>
            ))}
          </div>
          <p>
            Generate the session key from the ICICI Breeze portal. It expires at
            midnight or earlier if revoked. Secrets are encrypted on the server
            and never returned to this screen.
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect ICICI Direct"}
          </Button>
        </form>
      </Dialog>
    </>
  );
}
