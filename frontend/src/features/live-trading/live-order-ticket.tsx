"use client";
/** Explicit real-money ticket, separate from simulated ledgers. Never submits on mount or retry. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { createLatestRequest } from "@/lib/latest-request";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { useToast } from "@/components/ui/toast";
import type { BrokerInstrument } from "@/components/instrument-picker";
import styles from "./live-order-ticket.module.css";

type Intent = {
  instrument: string;
  side: "buy" | "sell";
  quantity: number;
  limitPaise: number;
  reduceOnly: boolean;
};
type Preview = {
  previewId: string;
  expires: number;
  intent: Intent;
  tradingSymbol: string;
  notionalPaise: number;
};
type LiveOrderState = {
  id: string;
  state: string;
  intent: Intent;
  brokerOrder?: { brokerOrderId: string; filledQuantity: number } | null;
};
type LiveStatus = {
  enabled: boolean;
  armed: boolean;
  halted: boolean;
  activeBrokerId?: string;
  provider?: string;
  reason?: string;
  orders?: LiveOrderState[];
};
const money = (paise: number) =>
  (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR" });

/** Broker order lifecycle values persisted by the OMS; purely presentational tones, not
 * a re-implementation of any state-machine logic owned by the backend. */
const ORDER_STATE_TONE: Record<string, BadgeTone> = {
  filled: "success",
  acknowledged: "success",
  open: "info",
  partially_filled: "info",
  reserved: "neutral",
  bound: "neutral",
  submitting: "warning",
  unknown: "warning",
  blocked: "danger",
  rejected: "danger",
  cancelled: "neutral",
};

/** Render explicit live controls, retaining server, MFA, risk and confirmation safeguards. */
export function LiveOrderTicket({
  csrf,
  initialOrder,
}: {
  csrf: string;
  initialOrder?: { contract: BrokerInstrument; side: "buy" | "sell" };
}) {
  const statusGate = useRef(createLatestRequest());
  const actionPending = useRef(false);
  const toast = useToast();
  const [status, setStatus] = useState<LiveStatus | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [configured, setConfigured] = useState(false);
  const [limits, setLimits] = useState({
    reserved: "",
    exposure: "",
    units: "",
    loss: "",
    rate: "",
  });
  const [token, setToken] = useState(""),
    [armProof, setArmProof] = useState("");
  const [market, setMarket] = useState<"cash" | "options">(
      initialOrder ? "options" : "cash",
    ),
    [query, setQuery] = useState(initialOrder?.contract.symbol ?? "");
  const [items, setItems] = useState<BrokerInstrument[]>([]),
    [selected, setSelected] = useState<BrokerInstrument | null>(null);
  const [side, setSide] = useState<"buy" | "sell">(initialOrder?.side ?? "buy"),
    [quantity, setQuantity] = useState(
      initialOrder ? String(initialOrder.contract.lotSize) : "",
    ),
    [price, setPrice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [proof, setProof] = useState("");
  const [uncertain, setUncertain] = useState(false);
  /** Read control status without arming, reconciling or submitting orders. */
  const refresh = useCallback(async () => {
    const read = statusGate.current.begin();
    const result = await requestApiJson(
      "/live/status",
      "GET",
      undefined,
      undefined,
      15000,
      read.signal,
    );
    if (read.isCurrent()) {
      setStatus(result);
      setConfigured(Boolean(result.accountId));
    }
    return result;
  }, []);
  /** Load status once and cancel obsolete reads on account change/unmount; never cancel or retry a submitted order here. */
  useEffect(() => {
    let active = true;
    void refresh().catch(
      /** Ignore failures from a departed account view. */ (e) => {
        if (active) {
          setError(e.message);
        }
      },
    );
    const gate = statusGate.current;
    /** Read cancellation changes UI ownership only, not broker state. */
    return () => {
      active = false;
      gate.invalidate();
    };
  }, [csrf, refresh]);
  /** Run explicit UI work with busy/error feedback; never automatically retry uncertain submissions. */
  async function action(work: () => Promise<void>) {
    if (actionPending.current) {
      return;
    }
    actionPending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  const post = (path: string, body: unknown = {}) =>
    requestApiJson(`/live/${path}`, "POST", body, csrf, 30000);
  /** Discard reviewed previews when inputs change so old confirmations cannot authorize different terms. */
  function invalidate() {
    setPreview(null);
    setProof("");
  }
  /** Halt account dispatch before requesting cancellation and then refresh broker-backed control state. */
  async function requestLiveTradingDisable() {
    await post("halt");
    invalidate();
    await refresh();
    setMessage(
      "Live trading disabled. Cancellation was requested but is not guaranteed; verify broker orders and positions.",
    );
  }
  /** Serialize the explicit disable action through the shared pending-action guard. */
  function handleLiveTradingDisable() {
    void action(requestLiveTradingDisable);
  }
  const orderColumns: DataTableColumn<LiveOrderState>[] = [
    { key: "instrument", header: "Intent", render: (o) => o.intent.instrument },
    {
      key: "side",
      header: "Side / quantity",
      render: (o) => (
        <span className={styles.mono}>
          {o.intent.side} / {o.intent.quantity}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (o) => (
        <Badge tone={ORDER_STATE_TONE[o.state] ?? "neutral"}>{o.state}</Badge>
      ),
    },
    {
      key: "brokerOrder",
      header: "Broker order",
      render: (o) => o.brokerOrder?.brokerOrderId ?? "Awaiting confirmation",
    },
    {
      key: "filled",
      header: "Filled units",
      align: "right",
      render: (o) => (
        <span className={styles.mono}>
          {o.brokerOrder?.filledQuantity ?? "—"}
        </span>
      ),
    },
  ];
  return (
    <section
      className={`live-execution-panel ${styles.panel}`}
      aria-label="Live execution controls"
    >
      <div className={styles.heading}>
        <div>
          <h2>Live execution</h2>
          <p>Execution capability · LIMIT / DAY · NSE cash and long options</p>
          {initialOrder && (
            <p className={styles.chainNote}>
              From option chain: {initialOrder.contract.symbol}. Search and
              select the exact contract from the active broker before reviewing.
              Chain tokens and prices are never used as execution authorization.
              Selling only reduces a tracked long position.
            </p>
          )}
        </div>
      </div>
      <fieldset disabled={busy}>
        <legend>Live trading control</legend>
        <p role="status" className={styles.statusLine}>
          Server capability: {status?.enabled ? "Available" : "Locked"} · Live
          trading: {status?.armed ? "Enabled" : "Disabled"} · Execution
          provider:{" "}
          {status?.provider?.toUpperCase() ??
            "Unavailable until execution status is available"}
          . {status?.reason}
        </p>
        <p className={styles.statusLine}>
          Enabling is temporary and requires reconciliation, an authenticator
          code and explicit confirmation. Disabling blocks new submissions
          first, then requests cancellation of non-terminal broker orders.
        </p>
        {configured && status?.enabled && (
          <Button variant="danger" onClick={handleLiveTradingDisable}>
            Disable live trading + cancel pending orders
          </Button>
        )}
      </fieldset>
      <p className={styles.sectionNote}>
        Use a dedicated trading account. Only reconciled, app-tracked exposure
        can be managed here; every live order requires explicit authorization.
        <Tooltip label="Unexplained positions or unknown order outcomes require review before continuing.">
          <button
            type="button"
            className={styles.infoTrigger}
            aria-label="More about account hygiene requirements"
          >
            <Info size={13} />
          </button>
        </Tooltip>
      </p>
      <p className={styles.statusLine}>
        Funds use the active broker&apos;s available buying power, not a settled
        cash ledger. Halting requests cancellation of app-managed orders; it
        does not close positions.
      </p>
      {error && (
        <p role="alert" className={styles.alert}>
          {error}
        </p>
      )}
      {message && (
        <p role="status" className={styles.status}>
          {message}
        </p>
      )}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void action(async () => {
            await refresh();
          })
        }
      >
        Check live status
      </Button>
      {status?.enabled === false ? (
        <p className={styles.statusLine}>
          Disabled by the server operator. Static-IP registration and explicit
          server configuration are required before activation.
        </p>
      ) : (
        <>
          {!configured && (
            <fieldset disabled={busy}>
              <legend>1. Configure risk limits (required)</legend>
              <div className="form-grid">
                {(
                  [
                    ["reserved", "Maximum reserved capital ₹"],
                    ["exposure", "Maximum gross exposure ₹"],
                    ["units", "Maximum position units"],
                    ["loss", "Maximum daily loss ₹"],
                    ["rate", "Orders per minute (1–60)"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label} htmlFor={`risk-${key}`}>
                    <Input
                      id={`risk-${key}`}
                      type="number"
                      min="1"
                      value={limits[key]}
                      onChange={(e) =>
                        setLimits({ ...limits, [key]: e.target.value })
                      }
                    />
                  </Field>
                ))}
              </div>
              <Button
                disabled={Object.values(limits).some(
                  (v) => !v || Number(v) <= 0,
                )}
                onClick={() =>
                  void action(async () => {
                    await post("configure", {
                      maxReservedPaise: Math.round(
                        Number(limits.reserved) * 100,
                      ),
                      maxGrossExposurePaise: Math.round(
                        Number(limits.exposure) * 100,
                      ),
                      maxPositionUnits: Number(limits.units),
                      maxDailyLossPaise: Math.round(Number(limits.loss) * 100),
                      maxOrdersPerMinute: Number(limits.rate),
                      fundsDriftTolerancePaise: 0,
                    });
                    await refresh();
                    toast({
                      tone: "success",
                      title: "Live risk limits saved",
                    });
                  })
                }
              >
                Save live risk limits
              </Button>
            </fieldset>
          )}
          {configured && (
            <>
              <fieldset disabled={busy}>
                <legend>2. Enable live trading for five minutes</legend>
                <Field
                  label="Fresh app authenticator or unused recovery code"
                  htmlFor="mfa-token"
                >
                  <Input
                    id="mfa-token"
                    type="password"
                    autoComplete="one-time-code"
                    maxLength={32}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </Field>
                <p className={styles.statusLine}>
                  Use a new code for each authorization. If you just changed
                  brokers, wait for your authenticator to show its next code.
                </p>
                <Field label="Type ENABLE REAL MONEY" htmlFor="arm-proof">
                  <Input
                    id="arm-proof"
                    value={armProof}
                    onChange={(e) => setArmProof(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                <div className={styles.actions}>
                  <Button
                    disabled={
                      status?.armed ||
                      armProof !== "ENABLE REAL MONEY" ||
                      !token
                    }
                    onClick={() =>
                      void action(async () => {
                        try {
                          await post("arm", { token, confirmation: armProof });
                          await refresh();
                        } finally {
                          setToken("");
                          setArmProof("");
                        }
                      })
                    }
                  >
                    Enable live trading
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void action(async () => {
                        await post("reconcile");
                        await refresh();
                        toast({
                          tone: "success",
                          title: "Broker books reconciled",
                        });
                      })
                    }
                  >
                    Reconcile broker books
                  </Button>
                </div>
              </fieldset>
              <fieldset disabled={busy || !status?.armed || uncertain}>
                <legend>3. Review a live order</legend>
                <div className="form-grid">
                  <Field label="Market" htmlFor="market-select">
                    <Select
                      id="market-select"
                      value={market}
                      onChange={(e) => {
                        setMarket(e.target.value as "cash" | "options");
                        setItems([]);
                        setSelected(null);
                        invalidate();
                      }}
                    >
                      <option value="cash">NSE cash (CNC)</option>
                      <option value="options">NSE options (NRML)</option>
                    </Select>
                  </Field>
                  <Field
                    label="Search active broker contract"
                    htmlFor="contract-query"
                  >
                    <Input
                      id="contract-query"
                      value={query}
                      onChange={(e) => setQuery(e.target.value.toUpperCase())}
                      placeholder="RELIANCE / NIFTY"
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void action(async () => {
                        const result = await post("instruments", {
                          market,
                          query,
                          offset: 0,
                        });
                        setItems(result.items);
                        setSelected(null);
                        invalidate();
                      })
                    }
                  >
                    Search contracts
                  </Button>
                  <Field label="Contract" htmlFor="contract-select">
                    <Select
                      id="contract-select"
                      value={selected?.masterToken ?? ""}
                      onChange={(e) => {
                        const row =
                          items.find((i) => i.masterToken === e.target.value) ??
                          null;
                        setSelected(row);
                        setQuantity(row ? String(row.lotSize) : "");
                        invalidate();
                      }}
                    >
                      <option value="">Select exact contract</option>
                      {items.map((i) => (
                        <option key={i.masterToken} value={i.masterToken}>
                          {i.name} · lot {i.lotSize}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Side" htmlFor="side-select">
                    <Select
                      id="side-select"
                      value={side}
                      onChange={(e) => {
                        setSide(e.target.value as "buy" | "sell");
                        invalidate();
                      }}
                    >
                      <option value="buy">Buy</option>
                      <option value="sell">
                        Sell — reduce tracked long only
                      </option>
                    </Select>
                  </Field>
                  <Field
                    label="Quantity (exchange units)"
                    htmlFor="quantity-input"
                  >
                    <Input
                      id="quantity-input"
                      type="number"
                      min="1"
                      value={quantity}
                      onChange={(e) => {
                        setQuantity(e.target.value);
                        invalidate();
                      }}
                    />
                  </Field>
                  <Field label="Limit price ₹" htmlFor="price-input">
                    <Input
                      id="price-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={price}
                      onChange={(e) => {
                        setPrice(e.target.value);
                        invalidate();
                      }}
                    />
                  </Field>
                </div>
                <Button
                  disabled={!selected || !quantity || !price}
                  onClick={() =>
                    void action(async () => {
                      const result = await post("preview", {
                        instrument: selected!.masterToken,
                        side,
                        quantity: Number(quantity),
                        limitPaise: Math.round(Number(price) * 100),
                        reduceOnly: side === "sell",
                      });
                      setPreview(result);
                      setProof("");
                    })
                  }
                >
                  Preview real order
                </Button>
              </fieldset>
              {preview && (
                <fieldset disabled={busy || uncertain}>
                  <legend>4. Confirm real-money submission</legend>
                  <p className={styles.previewSummary}>
                    {preview.intent.side.toUpperCase()}{" "}
                    <span className={styles.mono}>
                      {preview.intent.quantity} × {preview.tradingSymbol} at{" "}
                      {money(preview.intent.limitPaise)}
                    </span>
                    . Notional{" "}
                    <span className={styles.mono}>
                      {money(preview.notionalPaise)}
                    </span>{" "}
                    before fees. Preview expires at{" "}
                    {new Date(preview.expires).toLocaleTimeString()}.
                  </p>
                  <Field label="Type PLACE LIVE ORDER" htmlFor="submit-proof">
                    <Input
                      id="submit-proof"
                      value={proof}
                      onChange={(e) => setProof(e.target.value)}
                      autoComplete="off"
                    />
                  </Field>
                  <Button
                    disabled={
                      proof !== "PLACE LIVE ORDER" ||
                      Date.now() >= preview.expires
                    }
                    onClick={() =>
                      void action(async () => {
                        try {
                          const result = await post("orders", {
                            previewId: preview.previewId,
                            confirmation: proof,
                          });
                          setMessage(
                            `Order status: ${result.state}. Check broker reconciliation for final fills.`,
                          );
                          if (
                            ["unknown", "submitting"].includes(result.state)
                          ) {
                            setUncertain(true);
                          }
                          invalidate();
                          await refresh();
                        } catch (e) {
                          setUncertain(true);
                          throw e;
                        }
                      })
                    }
                  >
                    Place live order
                  </Button>
                </fieldset>
              )}
              {uncertain && (
                <p role="alert" className={styles.alert}>
                  Submission outcome needs review. New tickets are locked in
                  this view. Reconcile and check the active broker before
                  continuing; do not recreate this order.
                </p>
              )}
              <DataTable
                columns={orderColumns}
                rows={status?.orders ?? []}
                rowKey={(o) => o.id}
                emptyTitle="No live orders recorded in this session yet."
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
