"use client";

/** Research workbench: saved cash/options baskets, real-history replay and read-only quote feeds.
 * This component has no order-submission endpoint. Quotes and history are read-only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogActions,
  DialogDescription,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { OptionChainPicker } from "@/components/option-chain-picker";
import { StoredInstrumentPicker } from "@/components/stored-instrument-picker";
import { fetchStoredInstrument } from "@/lib/stored-market-data";
import { useUnsavedResearchWarning } from "@/features/workspace/workspace-views";
import {
  usePayoffCalculation,
  type PayoffCalculationInput,
} from "@/features/spread-builder/use-payoff-calculation";

import {
  createResearchDefinition,
  type ResearchDefinition as Definition,
  type ResearchLeg as Leg,
  type ResearchDraft,
} from "./research-draft";
import styles from "./research-workbench.module.css";
type Saved = { id: string; definition: Definition };
type Point = { time: number; pnl: number; prices: number[]; open: boolean };
type Run = {
  strategy: Definition;
  day: string;
  pnl: number;
  drawdown: number;
  totalFees: number;
  warnings: string[];
  points: Point[];
  fills: {
    time: number;
    leg: number;
    action: string;
    quantity: number;
    price: number;
    fee: number;
    reason: string;
  }[];
};
type Quote = {
  stockCode: string;
  price: number;
  bid: number;
  ask: number;
  observedAt: number | null;
  receivedAt?: number;
  stale: boolean;
};
const currency = (value: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    value,
  );
const timeLabel = (value: number) =>
  new Date(value).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  });
/** Requests are manual, bounded and same-origin. No credentials or draft orders go to storage. */
function researchRequest(
  path: string,
  csrf: string,
  method = "GET",
  body?: unknown,
) {
  return requestApiJson(`/research${path}`, method, body, csrf, 95000);
}

/** Lightweight repo-native SVG; no charting service, paid library or external market-data feed. */
function ResearchChart({ values, label }: { values: number[]; label: string }) {
  const low = Math.min(0, ...values),
    high = Math.max(1, ...values),
    span = high - low;
  const points = values
    .map(
      (value, index) =>
        `${30 + (index / Math.max(1, values.length - 1)) * 700},${180 - ((value - low) / span) * 150}`,
    )
    .join(" ");
  return (
    <div className="research-chart">
      <div>
        <span>{currency(high)}</span>
        <span>{currency(low)}</span>
      </div>
      <svg viewBox="0 0 760 210" role="img" aria-label={label}>
        <line
          x1="30"
          y1={180 + (low / span) * 150}
          x2="730"
          y2={180 + (low / span) * 150}
          style={{ stroke: "var(--border-strong)" }}
          strokeDasharray="5 5"
        />
        <polyline
          points={points}
          fill="none"
          style={{ stroke: "var(--accent)" }}
          strokeWidth="3"
        />
      </svg>
    </div>
  );
}

/** Manage an immutable saved definition separately from editable form state and fetched prices. */
export function ResearchWorkbench({
  csrf,
  initialStrategyId = "",
  initialMarket = "cash",
  draft,
  onDraftChange,
  onExploreOptionChain,
}: {
  csrf: string;
  initialStrategyId?: string;
  initialMarket?: "cash" | "options";
  draft?: ResearchDraft;
  onDraftChange?: (draft: ResearchDraft) => void;
  onExploreOptionChain?: () => void;
}) {
  const draftAtMount = useRef(draft);
  const [edited, setEdited] = useState(false);
  const [definition, setDefinition] = useState<Definition>(() =>
      structuredClone(
        draft?.definition ?? createResearchDefinition(initialMarket),
      ),
    ),
    [saved, setSaved] = useState<Saved[]>([]),
    [strategyId, setStrategyId] = useState(draft?.savedId ?? "");
  const [runs, setRuns] = useState<
      { id: string; strategy_id: string; created_at: string }[]
    >([]),
    [run, setRun] = useState<Run | null>(null),
    [quotes, setQuotes] = useState<Quote[]>([]);
  // Batch persistence shares the run library, but each session retains its own replay timeline.
  const [batch, setBatch] = useState<{
    sessions: Run[];
    summary: {
      sessionsRun: number;
      totalPnl: number;
      totalFees: number;
      worstSessionDrawdown: number;
      winningSessions: number;
      losingSessions: number;
      breakEvenSessions: number;
    };
    skipped: { day: string; reason: string }[];
  } | null>(null);
  const [day, setDay] = useState(""),
    [tab, setTab] = useState("builder");
  const interval = "day";
  const [batchDays, setBatchDays] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<{
    first: string;
    last: string;
  } | null>(null);
  const storedId = definition.legs[0]?.dataInstrumentId;
  const storedSymbol = definition.legs[0]?.stockCode;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [cursor, setCursor] = useState(0),
    [playing, setPlaying] = useState(false),
    [clock, setClock] = useState(Date.now());
  const [kotakPolling, setKotakPolling] = useState(false);
  const [tradeLogOpen, setTradeLogOpen] = useState(false);
  const actionPending = useRef(false);
  const confirm = useConfirm();
  const toast = useToast();
  useUnsavedResearchWarning(edited && !strategyId);
  // This workbench's live preview only ever reads Kotak; a different connected broker (or none)
  // must not leave the Kotak-labeled controls clickable and silently failing.
  const [kotakConnected, setKotakConnected] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void requestApiJson(
      "/brokers/kotak/status",
      "GET",
      undefined,
      undefined,
      15000,
      controller.signal,
    )
      .then((status) => {
        if (!controller.signal.aborted) {
          setKotakConnected(status?.connected === true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setKotakConnected(false);
        }
      });
    return () => controller.abort();
  }, []);
  /** Default replay to actual stored coverage, never yesterday or an invented trading session.
   * Resolved by exact ID: a saved strategy already carries a valid dataInstrumentId, and a fuzzy
   * symbol search can miss it on a crowded results page, wrongly demanding reselection. */
  useEffect(() => {
    const controller = new AbortController();
    setCoverage(null);
    setDay("");
    setBatchDays([]);
    if (!storedId || !storedSymbol) {
      return;
    }
    void fetchStoredInstrument(storedId, controller.signal)
      .then((item) => {
        if (!controller.signal.aborted && item) {
          setCoverage({ first: item.first_day, last: item.last_day });
          setDay(item.last_day);
        } else if (!controller.signal.aborted) {
          setError(
            "Stored coverage could not be loaded. Select the instrument again before replaying.",
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(
            "Stored coverage could not be loaded. Select the instrument again before replaying.",
          );
        }
      });
    return () => controller.abort();
  }, [csrf, storedId, storedSymbol]);
  /** Kotak live preview is explicit, bounded REST polling, not a claimed socket stream.
   * Stop on hidden tab, navigation, editing or failure; never start an order worker.
   */
  useEffect(() => {
    if (!kotakPolling) {
      return;
    }
    if (
      tab !== "quotes" ||
      !strategyId ||
      definition.broker !== "kotak" ||
      !kotakConnected
    ) {
      setKotakPolling(false);
      return;
    }
    let active = true,
      pending = false;
    const refresh = async () => {
      if (pending || document.hidden) {
        return;
      }
      pending = true;
      try {
        const result = await researchRequest("/quotes", csrf, "POST", {
          strategyId,
        });
        if (active) {
          setQuotes(result.quotes);
        }
      } catch (failure) {
        if (active) {
          setQuotes([]);
          setError((failure as Error).message);
          setKotakPolling(false);
        }
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    const stopHidden = () => {
      if (document.hidden) {
        setKotakPolling(false);
        setQuotes([]);
      }
    };
    document.addEventListener("visibilitychange", stopHidden);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", stopHidden);
    };
  }, [kotakPolling, strategyId, tab, definition.broker, kotakConnected, csrf]);
  /** Reload owner-scoped library metadata; large replay histories load only on selection. */
  async function reloadLibrary() {
    const result = await researchRequest("", csrf);
    setSaved(result.strategies);
    setRuns(result.runs);
  }
  /** Read saved research once per session; discard late results after navigation or session replacement. */
  useEffect(() => {
    let active = true;
    void researchRequest("", csrf)
      .then((result) => {
        if (active) {
          setSaved(result.strategies);
          setRuns(result.runs);
          const selected = (result.strategies as Saved[]).find(
            (item) => item.id === initialStrategyId,
          );
          if (
            !draftAtMount.current &&
            selected &&
            selected.definition.market === initialMarket
          ) {
            setDefinition(structuredClone(selected.definition));
            onDraftChange?.({
              definition: structuredClone(selected.definition),
              savedId: selected.id,
            });
            setStrategyId(selected.id);
          }
        }
      })
      .catch((failure) => {
        if (active) {
          setError(failure.message);
        }
      });
    return () => {
      active = false;
    };
  }, [csrf, initialStrategyId, initialMarket, onDraftChange]);
  /** Quote freshness needs a clock only while its view is visible; editing a basket needs no per-second render. */
  useEffect(() => {
    if (tab !== "quotes" || !quotes.length) {
      return;
    }
    /** Update visible freshness labels without fetching broker records. */
    const tick = () => {
      if (!document.hidden) {
        setClock(Date.now());
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    /** Release the clock when leaving quotes, clearing quotes or unmounting. */
    return () => clearInterval(timer);
  }, [tab, quotes.length]);
  /** Advance historical playback without invoking a second setter from inside a state updater. */
  useEffect(() => {
    if (!playing || !run) {
      return;
    }
    if (cursor >= run.points.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(
      /** Advance at most one completed bar, keeping the updater pure. */ () =>
        setCursor((current) => Math.min(current + 1, run.points.length - 1)),
      500,
    );
    /** A pause, seek or run replacement cancels the queued animation step. */
    return () => clearTimeout(timer);
  }, [playing, run, cursor]);
  /** Any edit invalidates fetched quote identity and the saved ID before another run or draft. */
  function edit(next: Definition) {
    setEdited(true);
    // A late saved-library response must not overwrite a newer user edit.
    draftAtMount.current = { definition: next, savedId: "" };
    if (initialMarket === "options") {
      onDraftChange?.({ definition: next, savedId: "" });
    }
    setKotakPolling(false);
    setDefinition(next);
    setStrategyId("");
    setQuotes([]);
    setNotice("");
  }
  /** Edit one research leg and invalidate derived previews without changing live execution state. */
  function editLeg(index: number, patch: Partial<Leg>) {
    edit({
      ...definition,
      legs: definition.legs.map((leg, i) =>
        i === index ? { ...leg, ...patch } : leg,
      ),
    });
  }
  /** Run explicit research work with busy/error feedback; historical results cannot dispatch orders. */
  async function act(action: () => Promise<void>) {
    if (actionPending.current) {
      return;
    }
    actionPending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  /** Templates are editable research starting points, not recommended trades or valid lot sizes. */
  function template(kind: string) {
    if ((kind === "cash") !== (initialMarket === "cash")) {
      return;
    }
    if (kind === "cash") {
      edit(createResearchDefinition("cash"));
      return;
    }
    const leg: Leg = {
      stockCode: "",
      side: "buy",
      quantity: 1,
      expiryDate: "",
      right: "call",
      strikePrice: 0,
    };
    edit({
      ...createResearchDefinition("options"),
      name:
        kind === "straddle"
          ? "Long straddle research"
          : "Bull call spread research",
      market: "options",
      marginReserve: kind === "spread" ? 50000 : 0,
      legs: [
        leg,
        {
          ...leg,
          ...(kind === "straddle"
            ? { right: "put" as const }
            : { side: "sell" as const, strikePrice: 0 }),
        },
      ],
    });
  }
  const allFresh =
    definition.legs.length > 0 &&
    quotes.length === definition.legs.length &&
    quotes.every(
      (quote) =>
        !quote.stale &&
        quote.observedAt &&
        clock - quote.observedAt <= 60000 &&
        (quote.receivedAt === undefined || clock - quote.receivedAt <= 30000),
    );
  const sameExpiry =
    definition.market === "options" &&
    definition.legs.every(
      (leg) =>
        leg.expiryDate === definition.legs[0].expiryDate &&
        leg.stockCode === definition.legs[0].stockCode,
    );
  const payoffRequest = useMemo<PayoffCalculationInput | null>(
    /** Use only recent same-expiry broker quotes to create a Python payoff request. */ () => {
      if (!allFresh || !sameExpiry) {
        return null;
      }
      const strikes = definition.legs.map((leg) => leg.strikePrice ?? 0);
      if (strikes.some((strike) => !Number.isFinite(strike) || strike <= 0)) {
        return null;
      }
      const spot = (Math.min(...strikes) + Math.max(...strikes)) / 2;
      return {
        legs: definition.legs.map((leg, index) => ({
          right: leg.right!,
          side: leg.side,
          strike: leg.strikePrice!,
          quantity: leg.quantity,
          premium: leg.side === "buy" ? quotes[index].ask : quotes[index].bid,
          iv: 0,
        })),
        spot,
        days: 0,
        rate: 0,
        dividend: 0,
        ivShift: 0,
        targetSpot: spot,
        totalFees: definition.feePerOrder * 2 * definition.legs.length,
      };
    },
    [allFresh, sameExpiry, definition.legs, definition.feePerOrder, quotes],
  );
  const payoffCalculation = usePayoffCalculation(csrf, payoffRequest);
  const payoff =
    payoffCalculation.result?.points.map((point) => point.expiry) ?? [];
  const payoffLow = payoffCalculation.result?.low ?? 0;
  const payoffHigh = payoffCalculation.result?.high ?? 0;
  const point = run?.points[cursor];
  const spreadRisk = payoffCalculation.result?.risk ?? null;
  const quoteColumns: DataTableColumn<Quote & { rowId: number }>[] = [
    {
      key: "leg",
      header: "Leg",
      render: (quote) => `${quote.rowId + 1} · ${quote.stockCode}`,
    },
    {
      key: "last",
      header: "Last",
      align: "right",
      render: (quote) => (
        <span className={styles.mono}>{currency(quote.price)}</span>
      ),
    },
    {
      key: "bid",
      header: "Bid",
      align: "right",
      render: (quote) => (
        <span className={styles.mono}>{currency(quote.bid)}</span>
      ),
    },
    {
      key: "ask",
      header: "Ask",
      align: "right",
      render: (quote) => (
        <span className={styles.mono}>{currency(quote.ask)}</span>
      ),
    },
    {
      key: "observed",
      header: "Last trade IST",
      render: (quote) =>
        quote.observedAt ? timeLabel(quote.observedAt) : "Unavailable",
    },
    {
      key: "freshness",
      header: "Freshness",
      render: (quote) => {
        const stale =
          quote.stale ||
          !quote.observedAt ||
          clock - quote.observedAt > 60000 ||
          (quote.receivedAt !== undefined && clock - quote.receivedAt > 30000);
        return (
          <Badge tone={stale ? "danger" : "success"}>
            {stale ? "STALE — refresh" : "Recent"}
          </Badge>
        );
      },
    },
  ];
  const tradeLogColumns: DataTableColumn<
    Run["fills"][number] & { rowId: number }
  >[] = [
    { key: "time", header: "Time IST", render: (fill) => timeLabel(fill.time) },
    { key: "leg", header: "Leg", render: (fill) => fill.leg + 1 },
    { key: "side", header: "Side", render: (fill) => fill.action },
    {
      key: "units",
      header: "Units",
      align: "right",
      render: (fill) => <span className={styles.mono}>{fill.quantity}</span>,
    },
    {
      key: "fill",
      header: "Fill",
      align: "right",
      render: (fill) => (
        <span className={styles.mono}>{currency(fill.price)}</span>
      ),
    },
    { key: "reason", header: "Reason", render: (fill) => fill.reason },
  ];
  const selectedLegColumns: DataTableColumn<{ leg: Leg; index: number }>[] = [
    { key: "side", header: "Side", render: ({ leg }) => leg.side },
    {
      key: "contract",
      header: "Contract",
      render: ({ leg }) => (
        <>
          {leg.stockCode || "Select a contract"} {leg.strikePrice || ""}{" "}
          {leg.right} <small>{leg.expiryDate}</small>
        </>
      ),
    },
    {
      key: "units",
      header: "Units",
      render: ({ leg, index }) => (
        <Input
          className="spread-units"
          type="number"
          min="1"
          step="1"
          disabled={busy}
          aria-label={`Units for ${leg.side} ${leg.stockCode} ${leg.strikePrice ?? ""} ${leg.right ?? ""}`}
          value={leg.quantity}
          onChange={(event) =>
            editLeg(index, {
              quantity: Number(event.target.value),
            })
          }
        />
      ),
    },
    {
      key: "premium",
      header: "Premium",
      render: ({ leg, index }) => (
        <span className={styles.mono}>
          {quotes[index] && allFresh
            ? currency(
                leg.side === "buy" ? quotes[index].ask : quotes[index].bid,
              )
            : "—"}
        </span>
      ),
    },
    {
      key: "remove",
      header: "",
      render: ({ leg, index }) => (
        <button
          type="button"
          className="workspace-icon-button"
          disabled={busy}
          aria-label={`Remove ${leg.side} ${leg.stockCode} ${leg.strikePrice ?? ""} ${leg.right ?? ""}`}
          onClick={() =>
            edit({
              ...definition,
              legs: definition.legs.filter(
                (_, itemIndex) => itemIndex !== index,
              ),
            })
          }
        >
          <Trash2 size={17} />
        </button>
      ),
    },
  ];
  return (
    <section
      className="research-lab"
      aria-label={
        initialMarket === "options" ? "Spread research" : "Strategy lab"
      }
    >
      <div className="environment">
        <div>
          <strong>
            {initialMarket === "options"
              ? "Construct and evaluate an options spread"
              : "Historical strategy research"}
          </strong>
          <span>
            Stored historical candles · Saved research · Separate real-money
            confirmation
          </span>
        </div>
        <Badge tone="warning">NO AUTO EXECUTION</Badge>
      </div>
      <Tabs
        items={[
          { key: "builder", label: "Definition & results" },
          { key: "quotes", label: "Live data preview" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {initialMarket === "options" && (
        <section className="screen-two-columns">
          <article className="panel screen-card">
            <h2>Selected legs</h2>
            <p>{definition.legs.length} legs · quantities are exchange units</p>
            <DataTable
              columns={selectedLegColumns}
              rows={definition.legs.map((leg, index) => ({ leg, index }))}
              rowKey={(row) => String(row.index)}
              emptyTitle="No legs selected"
              emptyDescription="Choose listed contracts below to start."
            />
            <Button
              variant="secondary"
              onClick={onExploreOptionChain ?? (() => setTab("builder"))}
            >
              Add from option chain
            </Button>
          </article>
          <article className="panel screen-card">
            <h2>Payoff at expiry</h2>
            {payoff.length ? (
              <ResearchChart
                values={payoff}
                label="Spread expiry payoff using broker bid and ask"
              />
            ) : (
              <p>
                Select and save same-expiry contracts, then load current quotes
                to calculate payoff.
              </p>
            )}
            <div className="research-summary">
              <div>
                <span>Maximum profit</span>
                <strong className={spreadRisk ? styles.positive : undefined}>
                  {!spreadRisk
                    ? "—"
                    : spreadRisk.unlimitedProfit
                      ? "Unbounded"
                      : currency(spreadRisk.maxProfit!)}
                </strong>
              </div>
              <div>
                <span>Maximum loss</span>
                <strong className={spreadRisk ? styles.negative : undefined}>
                  {!spreadRisk
                    ? "—"
                    : spreadRisk.unlimitedLoss
                      ? "Unbounded"
                      : currency(spreadRisk.maxLoss!)}
                </strong>
              </div>
              <div>
                <span>Breakeven</span>
                <strong>
                  {spreadRisk
                    ? spreadRisk.breakevens.map(currency).join(", ") || "None"
                    : "—"}
                </strong>
              </div>
            </div>
            <p>
              Risk figures and chart include configured flat fees. Taxes and
              slippage are excluded. Non-atomic fills can create additional
              risk. Live multi-leg execution is unavailable.
            </p>
            {payoffCalculation.error && (
              <p className="error" role="alert">
                {payoffCalculation.error}
              </p>
            )}
            <Button variant="secondary" onClick={() => setTab("quotes")}>
              Load premium quotes
            </Button>
          </article>
        </section>
      )}
      <div className="panel research-library">
        <Field
          label="Saved research strategy"
          htmlFor="research-saved-strategy"
          className={styles.libraryField}
        >
          <Select
            id="research-saved-strategy"
            value={strategyId}
            disabled={busy}
            onChange={(event) => {
              const selected = saved.find(
                (item) => item.id === event.target.value,
              );
              if (selected) {
                setDefinition(structuredClone(selected.definition));
                onDraftChange?.({
                  definition: structuredClone(selected.definition),
                  savedId: selected.id,
                });
                setStrategyId(selected.id);
                setQuotes([]);
                setNotice("Saved definition loaded.");
              } else {
                setStrategyId("");
                onDraftChange?.({ definition, savedId: "" });
                setQuotes([]);
              }
            }}
          >
            <option value="">Unsaved draft</option>
            {saved
              .filter((item) => item.definition.market === initialMarket)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.definition.name} · {item.definition.market}
                </option>
              ))}
          </Select>
        </Field>
        <Button
          disabled={busy || !strategyId}
          variant="danger"
          onClick={() => {
            void (async () => {
              const proceed = await confirm({
                title: "Delete this saved research strategy?",
                description:
                  "Delete this saved research strategy and its replay history? This does not affect live orders.",
                confirmLabel: "Delete",
                tone: "danger",
              });
              if (!proceed) {
                return;
              }
              await act(async () => {
                await researchRequest(
                  `/strategies/${strategyId}`,
                  csrf,
                  "DELETE",
                );
                setStrategyId("");
                onDraftChange?.({ definition, savedId: "" });
                setRun(null);
                setBatch(null);
                setQuotes([]);
                await reloadLibrary();
                toast({
                  tone: "success",
                  title: "Saved research deleted",
                });
              });
            })();
          }}
        >
          Delete saved research
        </Button>
      </div>
      <div
        className={
          tab === "builder" ? "research-workspace-columns" : "screen-stack"
        }
      >
        {tab === "builder" && (
          <div className="panel research-builder">
            <div className="section-heading">
              <div>
                <span className="eyebrow">01 · BUILD YOUR IDEA</span>
                <h2>
                  {definition.market === "options"
                    ? "Selected legs & rules"
                    : "Define a daily basket"}
                </h2>
              </div>
            </div>
            <div className="live-actions">
              {initialMarket === "cash" ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => template("cash")}
                >
                  Cash template
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => template("straddle")}
                  >
                    Long straddle
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => template("spread")}
                  >
                    Bull call spread
                  </Button>
                </>
              )}
            </div>
            {definition.market === "options" && (
              <OptionChainPicker
                csrf={csrf}
                legCount={definition.legs.length}
                disabled={busy}
                onSelect={(leg, index) => {
                  edit({
                    ...definition,
                    legs:
                      index === definition.legs.length
                        ? [...definition.legs, leg]
                        : definition.legs.map((current, i) =>
                            i === index ? leg : current,
                          ),
                  });
                  setNotice(
                    "Contract selected. Verify quantity units and margin assumption, then save the strategy.",
                  );
                }}
              />
            )}
            <p>
              Historical source: stored daily dataset · Live preview source:
              Kotak Neo
            </p>
            {definition.broker === "kotak" && definition.market === "cash" && (
              <StoredInstrumentPicker
                disabled={busy}
                onSelect={(item) => {
                  edit({
                    ...definition,
                    legs: [
                      {
                        stockCode: item.symbol,
                        dataInstrumentId: item.id,
                        side: "buy",
                        quantity: 1,
                      },
                    ],
                  });
                  setDay(item.last_day);
                }}
              />
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  const result = await researchRequest(
                    "/strategies",
                    csrf,
                    "POST",
                    definition,
                  );
                  setStrategyId(result.id);
                  setDefinition(result.definition);
                  onDraftChange?.({
                    definition: result.definition,
                    savedId: result.id,
                  });
                  await reloadLibrary();
                  setNotice(
                    "Saved. Run a backtest from Definition & results or choose Live data preview.",
                  );
                });
              }}
            >
              <fieldset disabled={busy}>
                <div className="research-fields">
                  <Field label="Research name" htmlFor="research-name">
                    <Input
                      id="research-name"
                      value={definition.name}
                      onChange={(event) =>
                        edit({ ...definition, name: event.target.value })
                      }
                      required
                      minLength={3}
                      maxLength={80}
                    />
                  </Field>
                  <Field label="Market" htmlFor="research-market">
                    <Select
                      id="research-market"
                      value={definition.market}
                      disabled
                    >
                      <option value={definition.market}>
                        {definition.market === "cash"
                          ? "NSE cash — one long leg"
                          : "NFO options — up to four legs"}
                      </option>
                    </Select>
                  </Field>
                </div>
                <p className="research-note">
                  {definition.market === "cash" ? (
                    "Choose an exact stored cash/index instrument and enter units. Daily research uses its saved historical candles; it does not place live orders."
                  ) : (
                    <>
                      Options quantities are{" "}
                      <strong>contract units, not lots</strong>. Option legs
                      support payoff and live preview; underlying daily candles
                      cannot reproduce historical option premiums.
                    </>
                  )}
                </p>
                {definition.legs.map((leg, index) => (
                  <div className="research-leg" key={index}>
                    <div className="section-heading">
                      <h3>Leg {index + 1}</h3>
                      {definition.market === "options" &&
                        definition.legs.length > 1 && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() =>
                              edit({
                                ...definition,
                                legs: definition.legs.filter(
                                  (_, i) => i !== index,
                                ),
                              })
                            }
                          >
                            Remove leg {index + 1}
                          </Button>
                        )}
                    </div>
                    <div className="research-fields">
                      <Field
                        label={`Stock code ${index + 1}`}
                        htmlFor={`research-leg-${index}-stockcode`}
                      >
                        <Input
                          id={`research-leg-${index}-stockcode`}
                          required
                          value={leg.stockCode}
                          maxLength={30}
                          readOnly={definition.market === "cash"}
                          onChange={(event) =>
                            editLeg(index, {
                              stockCode: event.target.value.toUpperCase(),
                            })
                          }
                        />
                      </Field>
                      <Field
                        label={`Side ${index + 1}`}
                        htmlFor={`research-leg-${index}-side`}
                      >
                        <Select
                          id={`research-leg-${index}-side`}
                          value={leg.side}
                          onChange={(event) =>
                            editLeg(index, {
                              side: event.target.value as Leg["side"],
                            })
                          }
                        >
                          <option value="buy">Buy</option>
                          {definition.market === "options" && (
                            <option value="sell">Sell</option>
                          )}
                        </Select>
                      </Field>
                      <Field
                        label={`Quantity units ${index + 1}`}
                        htmlFor={`research-leg-${index}-quantity`}
                      >
                        <Input
                          id={`research-leg-${index}-quantity`}
                          type="number"
                          min={1}
                          max={10000}
                          required
                          value={leg.quantity}
                          onChange={(event) =>
                            editLeg(index, {
                              quantity: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      {definition.market === "options" && (
                        <>
                          <Field
                            label={`Expiry ${index + 1}`}
                            htmlFor={`research-leg-${index}-expiry`}
                          >
                            <Input
                              id={`research-leg-${index}-expiry`}
                              type="date"
                              required
                              value={leg.expiryDate || ""}
                              onChange={(event) =>
                                editLeg(index, {
                                  expiryDate: event.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field
                            label={`Option type ${index + 1}`}
                            htmlFor={`research-leg-${index}-right`}
                          >
                            <Select
                              id={`research-leg-${index}-right`}
                              value={leg.right}
                              onChange={(event) =>
                                editLeg(index, {
                                  right: event.target.value as Leg["right"],
                                })
                              }
                            >
                              <option value="call">Call</option>
                              <option value="put">Put</option>
                            </Select>
                          </Field>
                          <Field
                            label={`Strike ${index + 1}`}
                            htmlFor={`research-leg-${index}-strike`}
                          >
                            <Input
                              id={`research-leg-${index}-strike`}
                              type="number"
                              min="0.01"
                              step="0.01"
                              max={1000000}
                              required
                              value={leg.strikePrice || ""}
                              onChange={(event) =>
                                editLeg(index, {
                                  strikePrice: Number(event.target.value),
                                })
                              }
                            />
                          </Field>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {definition.market === "options" && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={definition.legs.length >= 4}
                    onClick={() =>
                      edit({
                        ...definition,
                        legs: [
                          ...definition.legs,
                          {
                            ...definition.legs[0],
                            strikePrice:
                              (definition.legs[0].strikePrice || 0) +
                              500 * definition.legs.length,
                          },
                        ],
                      })
                    }
                  >
                    Add option leg
                  </Button>
                )}
                <h3 className="research-rules-title">
                  Timing & research assumptions
                </h3>
                <div className="research-fields">
                  {definition.market === "options" ? (
                    <>
                      <Field
                        label="Entry time (IST)"
                        htmlFor="research-entry-time"
                      >
                        <Input
                          id="research-entry-time"
                          type="time"
                          required
                          min="09:15"
                          max="15:20"
                          value={definition.entryTime}
                          onChange={(event) =>
                            edit({
                              ...definition,
                              entryTime: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field
                        label="Exit time (IST)"
                        htmlFor="research-exit-time"
                      >
                        <Input
                          id="research-exit-time"
                          type="time"
                          required
                          min="09:20"
                          max="15:25"
                          value={definition.exitTime}
                          onChange={(event) =>
                            edit({
                              ...definition,
                              exitTime: event.target.value,
                            })
                          }
                        />
                      </Field>
                    </>
                  ) : (
                    <Field
                      label="Stored daily fill model"
                      htmlFor="research-fill-model"
                    >
                      <Input
                        id="research-fill-model"
                        value="Entry at open · exit at stop, target or close"
                        readOnly
                      />
                    </Field>
                  )}
                  {(
                    [
                      ["capital", "Simulated capital (₹)", 100],
                      ["marginReserve", "Assumed margin reserve (₹)", 0],
                      ["stopLoss", "Basket stop loss (₹)", 1],
                      ["targetProfit", "Basket target profit (₹)", 1],
                      ["slippageBps", "Slippage per fill (basis points)", 0],
                      ["feePerOrder", "Fee per leg per fill (₹)", 0],
                    ] as const
                  ).map(([key, label, min]) => (
                    <Field key={key} label={label} htmlFor={`research-${key}`}>
                      <Input
                        id={`research-${key}`}
                        type="number"
                        min={min}
                        step="0.01"
                        required
                        value={definition[key]}
                        onChange={(event) =>
                          edit({
                            ...definition,
                            [key]: Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
                <p className="research-note">
                  {definition.market === "cash"
                    ? "Stored daily OHLC cannot prove intraday ordering. Entry is modeled at the open; stop wins if both stop and target are touched; otherwise the position exits at target or close."
                    : "Option timing is retained for payoff and live-preview definitions. Historical option replay is unavailable until a stored option-premium dataset is added."}
                </p>
                <Button type="submit">Save research strategy</Button>
              </fieldset>
            </form>
          </div>
        )}
        {tab === "builder" && (
          <div className="screen-stack">
            <section className="panel">
              <span className="eyebrow">02 · REPLAY THE SESSION</span>
              <h2>Backtest results</h2>
              <p>
                Select a saved cash/index strategy and a session covered by the
                stored daily dataset. No broker connection or fallback data is
                used.
              </p>
              {definition.market === "options" && (
                <p role="status">
                  Historical option simulation is unavailable because the stored
                  dataset has no option-premium candles. Use payoff analysis or
                  live preview for option definitions.
                </p>
              )}
              <div className="research-fields">
                <Field
                  label="Historical session (IST)"
                  htmlFor="research-session-date"
                >
                  <Input
                    id="research-session-date"
                    type="date"
                    value={day}
                    min={coverage?.first}
                    max={coverage?.last}
                    disabled={busy || !coverage}
                    onChange={(event) => setDay(event.target.value)}
                  />
                </Field>
                <Field
                  label="Candle interval"
                  htmlFor="research-candle-interval"
                >
                  <Input
                    id="research-candle-interval"
                    value="Daily stored OHLC"
                    readOnly
                  />
                </Field>
              </div>
              <Button
                disabled={
                  busy ||
                  !strategyId ||
                  !day ||
                  !coverage ||
                  day < coverage.first ||
                  day > coverage.last ||
                  definition.market !== "cash"
                }
                onClick={() =>
                  void act(async () => {
                    const result = await researchRequest(
                      "/backtest",
                      csrf,
                      "POST",
                      { strategyId, day, interval },
                    );
                    setRun(result);
                    setBatch(null);
                    setCursor(0);
                    setPlaying(false);
                    await reloadLibrary();
                    setNotice(
                      "Historical run saved. Press Play to walk through completed candles.",
                    );
                  })
                }
              >
                {busy
                  ? "Loading stored history…"
                  : "Run stored daily simulation"}
              </Button>
              <p role="status">
                {coverage
                  ? `Stored coverage: ${coverage.first} to ${coverage.last}. Holidays and missing sessions may have no candles.`
                  : "Choose an exact stored instrument to load available dates."}{" "}
                {!strategyId &&
                  "Save the definition before running a backtest."}
              </p>
              <h3>Batch sessions · {batchDays.length}/20</h3>
              <Button
                variant="secondary"
                disabled={
                  busy ||
                  !coverage ||
                  !day ||
                  day < (coverage?.first ?? "") ||
                  day > (coverage?.last ?? "") ||
                  batchDays.includes(day) ||
                  batchDays.length >= 20
                }
                onClick={() => setBatchDays((days) => [...days, day].sort())}
              >
                Add selected date to batch
              </Button>
              <div
                className="screen-toolbar"
                role="group"
                aria-label="Selected batch sessions"
              >
                {batchDays.map((value) => (
                  <Button
                    key={value}
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Remove ${value} from batch`}
                    onClick={() =>
                      setBatchDays((days) =>
                        days.filter((item) => item !== value),
                      )
                    }
                  >
                    {value} ×
                  </Button>
                ))}
              </div>
              <p>
                Up to 20 completed dates. Each day starts with the same capital;
                no compounding or overnight exposure. Missing history is
                skipped. Runs read the stored database and do not consume a
                broker API budget.
              </p>
              <Button
                disabled={
                  busy ||
                  !strategyId ||
                  !batchDays.length ||
                  definition.market !== "cash"
                }
                onClick={() =>
                  void act(async () => {
                    const result = await researchRequest(
                      "/backtest/batch",
                      csrf,
                      "POST",
                      {
                        strategyId,
                        interval,
                        days: batchDays,
                      },
                    );
                    setBatch(result);
                    setRun(result.sessions[0]);
                    setCursor(0);
                    setPlaying(false);
                    await reloadLibrary();
                    setNotice(
                      `Batch saved: ${result.summary.sessionsRun} completed, ${result.skipped.length} skipped or not attempted.`,
                    );
                  })
                }
              >
                Run batch backtest
              </Button>
              <Field
                label="Saved replay"
                htmlFor="research-saved-replay"
                className="research-run-select"
              >
                <Select
                  id="research-saved-replay"
                  value=""
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value) {
                      void act(async () => {
                        const result = await researchRequest(
                          `/runs/${event.target.value}`,
                          csrf,
                        );
                        setBatch(result.mode === "batch" ? result : null);
                        setRun(
                          result.mode === "batch" ? result.sessions[0] : result,
                        );
                        setCursor(0);
                        setPlaying(false);
                      });
                    }
                  }}
                >
                  <option value="">Load a previous run</option>
                  {runs.map((item) => (
                    <option value={item.id} key={item.id}>
                      {saved.find((entry) => entry.id === item.strategy_id)
                        ?.definition.name || "Research"}{" "}
                      · {new Date(item.created_at).toLocaleString()}
                    </option>
                  ))}
                </Select>
              </Field>
            </section>
            {!run && (
              <section className="panel screen-card">
                <h2>No backtest loaded</h2>
                <p>
                  Save your definition, then run a completed session or open a
                  saved report. Results use stored historical candles, modeled
                  costs and explicit fill assumptions.
                </p>
                <p>
                  This engine evaluates scheduled entry/exit baskets. Use
                  Backtest studio for daily EMA, RSI and channel-breakout signal
                  strategies.
                </p>
              </section>
            )}
            {batch && (
              <section className="panel research-results">
                <h2>
                  Independent daily batch · {batch.summary.sessionsRun} sessions
                </h2>
                <p>
                  No compounding or overnight positions. Worst session drawdown
                  is not continuous multi-day drawdown. Trade counts mean fills,
                  not round trips.
                </p>
                <p>
                  Net P&amp;L{" "}
                  <span
                    className={`${styles.mono} ${batch.summary.totalPnl >= 0 ? styles.positive : styles.negative}`}
                  >
                    {currency(batch.summary.totalPnl)}
                  </span>{" "}
                  · Fees{" "}
                  <span className={styles.mono}>
                    {currency(batch.summary.totalFees)}
                  </span>{" "}
                  · Worst session drawdown{" "}
                  <span className={`${styles.mono} ${styles.negative}`}>
                    {currency(batch.summary.worstSessionDrawdown)}
                  </span>
                </p>
                <p>
                  {batch.summary.winningSessions} winning ·{" "}
                  {batch.summary.losingSessions} losing ·{" "}
                  {batch.summary.breakEvenSessions} break-even sessions
                </p>
                <Field
                  label="Batch replay session"
                  htmlFor="research-batch-day"
                >
                  <Select
                    id="research-batch-day"
                    value={run?.day || ""}
                    onChange={(event) => {
                      setRun(
                        batch.sessions.find(
                          (session) => session.day === event.target.value,
                        ) || null,
                      );
                      setCursor(0);
                      setPlaying(false);
                    }}
                  >
                    {batch.sessions.map((session) => (
                      <option key={session.day} value={session.day}>
                        {session.day}
                      </option>
                    ))}
                  </Select>
                </Field>
                {batch.skipped.map((session) => (
                  <p key={session.day}>
                    {session.day}: {session.reason}
                  </p>
                ))}
              </section>
            )}
            {run && point && (
              <section className="panel research-results">
                <span className="eyebrow">
                  BROKER HISTORICAL DATA · SIMULATED FILLS
                </span>
                <h2>
                  {run.strategy.name} · {run.day}
                </h2>
                <div className="research-summary">
                  <div>
                    <span>Full-session net P&L</span>
                    <strong
                      className={
                        run.pnl >= 0 ? styles.positive : styles.negative
                      }
                    >
                      {currency(run.pnl)}
                    </strong>
                  </div>
                  <div>
                    <span>Maximum candle drawdown</span>
                    <strong className={styles.negative}>
                      {currency(run.drawdown)}
                    </strong>
                  </div>
                  <div>
                    <span>Total modeled fees</span>
                    <strong>{currency(run.totalFees)}</strong>
                  </div>
                </div>
                <div className="live-actions">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setCursor(0);
                      setPlaying(false);
                    }}
                  >
                    Rewind
                  </Button>
                  <Button
                    onClick={() => setPlaying(!playing)}
                    disabled={cursor === run.points.length - 1}
                  >
                    {playing ? "Pause replay" : "Play replay"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={cursor === run.points.length - 1}
                    onClick={() => {
                      setPlaying(false);
                      setCursor(cursor + 1);
                    }}
                  >
                    Next candle
                  </Button>
                  <span>
                    {timeLabel(point.time)} IST ·{" "}
                    {point.open ? "Basket open" : "Flat"} ·{" "}
                    {currency(point.pnl)}
                  </span>
                </div>
                <input
                  aria-label="Replay candle"
                  type="range"
                  min={0}
                  max={run.points.length - 1}
                  value={cursor}
                  onChange={(event) => {
                    setPlaying(false);
                    setCursor(Number(event.target.value));
                  }}
                />
                <ResearchChart
                  values={run.points
                    .slice(0, cursor + 1)
                    .map((item) => item.pnl)}
                  label="Historical basket P&L up to the replay cursor"
                />
                <p>
                  {point.prices
                    .map(
                      (price, index) => `Leg ${index + 1}: ${currency(price)}`,
                    )
                    .join(" · ")}
                </p>
                <Button
                  variant="secondary"
                  onClick={() => setTradeLogOpen(true)}
                >
                  View trade log
                </Button>
                <Dialog
                  open={tradeLogOpen}
                  onClose={() => setTradeLogOpen(false)}
                  title="Historical trade log"
                  labelledBy="research-trade-log-title"
                  className={styles.wideDialog}
                >
                  <DialogDescription>
                    {run.strategy.name} · {run.day} · Modeled fills from broker
                    candles, not exchange executions.
                  </DialogDescription>
                  <DataTable
                    columns={tradeLogColumns}
                    rows={run.fills
                      .filter((fill) => fill.time <= point.time)
                      .map((fill, index) => ({ ...fill, rowId: index }))}
                    rowKey={(fill) => String(fill.rowId)}
                    emptyTitle="No fills yet"
                    emptyDescription="No completed fills up to this replay candle."
                  />
                  <DialogActions>
                    <Button
                      variant="secondary"
                      onClick={() => setTradeLogOpen(false)}
                    >
                      Close trade log
                    </Button>
                  </DialogActions>
                </Dialog>
                <ul className="research-note">
                  {run.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
      {tab === "quotes" && (
        <section className="panel">
          <span className="eyebrow">03 · OBSERVE, THEN REVIEW</span>
          <h2>Live data preview</h2>
          <p>
            Kotak uses real quote snapshots or optional 15-second polling.
            Basket prices are not atomic; old exchange timestamps are marked
            stale.
          </p>
          {kotakConnected === false && (
            <p role="note" className="research-note">
              This preview only reads Kotak. Connect Kotak under Brokers to use
              it; it will not work with a different connected broker.
            </p>
          )}
          <Button
            disabled={
              busy || !strategyId || kotakPolling || kotakConnected !== true
            }
            onClick={() =>
              void act(async () => {
                setQuotes([]);
                const result = await researchRequest("/quotes", csrf, "POST", {
                  strategyId,
                });
                setQuotes(result.quotes);
              })
            }
          >
            {busy ? "Fetching quotes…" : "Refresh live quotes"}
          </Button>
          <div className="live-actions research-stream-actions">
            {
              <>
                <Button
                  disabled={
                    busy ||
                    !strategyId ||
                    kotakPolling ||
                    kotakConnected !== true
                  }
                  onClick={() => {
                    setQuotes([]);
                    setKotakPolling(true);
                  }}
                >
                  Start Kotak live polling
                </Button>
                <Button
                  disabled={!kotakPolling}
                  onClick={() => setKotakPolling(false)}
                >
                  Stop Kotak live polling
                </Button>
                <span role="status">
                  {kotakPolling
                    ? "Kotak quotes every 15 seconds"
                    : "Kotak polling stopped"}
                </span>
              </>
            }
          </div>
          <p className="research-note">
            Kotak polls real REST quotes every 15 seconds while this view is
            visible. Leaving this view stops polling. This never arms or submits
            orders.
          </p>
          {!!quotes.length && (
            <>
              <DataTable
                columns={quoteColumns}
                rows={quotes.map((quote, index) => ({
                  ...quote,
                  rowId: index,
                }))}
                rowKey={(quote) => String(quote.rowId)}
              />
              {definition.market === "options" && (
                <>
                  <p className="error">
                    Options baskets are research-only. Real-order submission is
                    not supported.
                  </p>
                  {payoff.length > 0 && (
                    <>
                      <h3>Illustrative expiry payoff</h3>
                      <ResearchChart
                        values={payoff}
                        label="Illustrative options expiry payoff using current bid and ask premiums"
                      />
                      <p>
                        Underlying at expiry: {currency(payoffLow)} →{" "}
                        {currency(payoffHigh)}. Assumes all legs fill at
                        displayed bid/ask; fees included, taxes and slippage
                        excluded. The plotted range does not bound your risk.
                      </p>
                    </>
                  )}
                  {!sameExpiry && (
                    <p>
                      Expiry payoff requires the same underlying and expiry for
                      every leg.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
