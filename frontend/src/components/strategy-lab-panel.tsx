"use client";

/** Research workbench: saved cash/options baskets, real-history replay and read-only quote feeds.
 * This component has no order-submission endpoint. Quotes and history are read-only.
 */
import { useEffect, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "./ui/button";
import { OptionChainPicker } from "./option-chain-picker";
import { PaperInstrumentPicker } from "./paper-instrument-picker";

type Leg = {
  stockCode: string;
  side: "buy" | "sell";
  quantity: number;
  expiryDate?: string;
  right?: "call" | "put";
  strikePrice?: number;
};
type Definition = {
  broker: "kotak";
  name: string;
  market: "cash" | "options";
  legs: Leg[];
  capital: number;
  marginReserve: number;
  entryTime: string;
  exitTime: string;
  stopLoss: number;
  targetProfit: number;
  slippageBps: number;
  feePerOrder: number;
};
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
const initial: Definition = {
  broker: "kotak",
  name: "Cash intraday basket",
  market: "cash",
  legs: [{ stockCode: "RELIANCE", side: "buy", quantity: 1 }],
  capital: 100000,
  marginReserve: 0,
  entryTime: "09:20",
  exitTime: "15:15",
  stopLoss: 2000,
  targetProfit: 4000,
  slippageBps: 5,
  feePerOrder: 20,
};

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
          stroke="#d9e0ed"
          strokeDasharray="5 5"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#5468ea"
          strokeWidth="3"
        />
      </svg>
    </div>
  );
}

/** Manage an immutable saved definition separately from editable form state and fetched prices. */
export function StrategyLabPanel({ csrf }: { csrf: string }) {
  const [definition, setDefinition] = useState<Definition>(
      structuredClone(initial),
    ),
    [saved, setSaved] = useState<Saved[]>([]),
    [strategyId, setStrategyId] = useState("");
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
  const [day, setDay] = useState(
      new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    ),
    [interval, setIntervalValue] = useState("5minute"),
    [tab, setTab] = useState("builder");
  const [batchDays, setBatchDays] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [cursor, setCursor] = useState(0),
    [playing, setPlaying] = useState(false),
    [clock, setClock] = useState(Date.now());
  const [kotakPolling, setKotakPolling] = useState(false);
  /** Kotak live preview is explicit, bounded REST polling, not a claimed socket stream.
   * Stop on hidden tab, navigation, editing or failure; never start an order worker.
   */
  useEffect(() => {
    if (!kotakPolling) {
      return;
    }
    if (tab !== "quotes" || !strategyId || definition.broker !== "kotak") {
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
  }, [kotakPolling, strategyId, tab, definition.broker, csrf]);
  /** Reload owner-scoped library metadata; large replay histories load only on selection. */
  async function reloadLibrary() {
    const result = await researchRequest("", csrf);
    setSaved(result.strategies);
    setRuns(result.runs);
  }
  useEffect(() => {
    let active = true;
    void researchRequest("", csrf)
      .then((result) => {
        if (active) {
          setSaved(result.strategies);
          setRuns(result.runs);
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
  }, [csrf]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!playing || !run) {
      return;
    }
    const timer = setInterval(
      () =>
        setCursor((current) => {
          if (current >= run.points.length - 1) {
            setPlaying(false);
            return current;
          }
          return current + 1;
        }),
      500,
    );
    return () => clearInterval(timer);
  }, [playing, run]);
  /** Any edit invalidates fetched quote identity and the saved ID before another run or draft. */
  function edit(next: Definition) {
    setKotakPolling(false);
    setDefinition(next);
    setStrategyId("");
    setQuotes([]);
    setNotice("");
  }
  function editLeg(index: number, patch: Partial<Leg>) {
    edit({
      ...definition,
      legs: definition.legs.map((leg, i) =>
        i === index ? { ...leg, ...patch } : leg,
      ),
    });
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** Templates are editable research starting points, not recommended trades or valid lot sizes. */
  function template(kind: string) {
    if (kind === "cash") {
      edit(structuredClone(initial));
      return;
    }
    const leg: Leg = {
      stockCode: "NIFTY",
      side: "buy",
      quantity: 1,
      expiryDate: "",
      right: "call",
      strikePrice: 24000,
    };
    edit({
      ...initial,
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
            : { side: "sell" as const, strikePrice: 24500 }),
        },
      ],
    });
  }
  const allFresh =
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
  const strikes = definition.legs.map((leg) => leg.strikePrice || 0),
    payoffLow = Math.min(...strikes) * 0.8,
    payoffHigh = Math.max(...strikes) * 1.2;
  const payoff =
    allFresh && sameExpiry
      ? Array.from({ length: 61 }, (_, index) => {
          const spot = payoffLow + ((payoffHigh - payoffLow) * index) / 60;
          return definition.legs.reduce(
            (sum, leg, i) =>
              sum +
              (leg.side === "buy" ? 1 : -1) *
                leg.quantity *
                (Math.max(
                  0,
                  leg.right === "call"
                    ? spot - leg.strikePrice!
                    : leg.strikePrice! - spot,
                ) -
                  (leg.side === "buy" ? quotes[i].ask : quotes[i].bid)) -
              2 * definition.feePerOrder,
            0,
          );
        })
      : [];
  const point = run?.points[cursor];
  return (
    <section className="research-lab" aria-label="Strategy lab">
      <div className="environment">
        <div>
          <strong>Research lab · Cash & options</strong>
          <span>
            Selected broker historical candles · Saved baskets · Separate
            real-money confirmation
          </span>
        </div>
        <span className="badge">NO AUTO EXECUTION</span>
      </div>
      <div className="research-tabs" role="group" aria-label="Research views">
        {[
          ["builder", "Strategy builder"],
          ["simulator", "Historical simulator"],
          ["quotes", "Live data preview"],
        ].map(([id, label]) => (
          <Button
            key={id}
            variant={tab === id ? "primary" : "secondary"}
            onClick={() => setTab(id)}
          >
            {label}
          </Button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="panel research-library">
        <label>
          Saved research strategy
          <select
            value={strategyId}
            disabled={busy}
            onChange={(event) => {
              const selected = saved.find(
                (item) => item.id === event.target.value,
              );
              if (selected) {
                setDefinition(structuredClone(selected.definition));
                setStrategyId(selected.id);
                setQuotes([]);
                setNotice("Saved definition loaded.");
              } else {
                setStrategyId("");
                setQuotes([]);
              }
            }}
          >
            <option value="">Unsaved draft</option>
            {saved.map((item) => (
              <option key={item.id} value={item.id}>
                {item.definition.name} · {item.definition.market}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={busy || !strategyId}
          variant="danger"
          onClick={() => {
            if (
              !window.confirm(
                "Delete this saved research strategy and its replay history? This does not affect live orders.",
              )
            ) {
              return;
            }
            void act(async () => {
              await researchRequest(
                `/strategies/${strategyId}`,
                csrf,
                "DELETE",
              );
              setStrategyId("");
              setRun(null);
              setBatch(null);
              setQuotes([]);
              await reloadLibrary();
            });
          }}
        >
          Delete saved research
        </Button>
      </div>
      {tab === "builder" && (
        <div className="panel research-builder">
          <div className="section-heading">
            <div>
              <span className="eyebrow">01 · BUILD YOUR IDEA</span>
              <h2>Define a scheduled basket</h2>
            </div>
          </div>
          <div className="live-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => template("cash")}
            >
              Cash template
            </Button>
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
          <p>Research data broker: Kotak Neo</p>
          {definition.broker === "kotak" && definition.market === "cash" && (
            <PaperInstrumentPicker
              broker="kotak"
              market="cash"
              csrf={csrf}
              disabled={busy}
              onSelect={(item) =>
                edit({
                  ...definition,
                  legs: [
                    {
                      stockCode: item.symbol,
                      side: "buy",
                      quantity: item.lotSize,
                    },
                  ],
                })
              }
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
                await reloadLibrary();
                setNotice(
                  "Saved. Choose Historical simulator or Live data preview next.",
                );
              });
            }}
          >
            <fieldset disabled={busy}>
              <div className="research-fields">
                <label>
                  Research name
                  <input
                    value={definition.name}
                    onChange={(event) =>
                      edit({ ...definition, name: event.target.value })
                    }
                    required
                    minLength={3}
                    maxLength={80}
                  />
                </label>
                <label>
                  Market
                  <select
                    value={definition.market}
                    onChange={(event) =>
                      template(
                        event.target.value === "cash" ? "cash" : "straddle",
                      )
                    }
                  >
                    <option value="cash">NSE cash — one long leg</option>
                    <option value="options">
                      NFO options — up to four legs
                    </option>
                  </select>
                </label>
              </div>
              <p className="research-note">
                Use the selected broker's exact symbols. Options quantities are{" "}
                <strong>contract units, not lots</strong>; enter the correct
                historical lot multiple. Template strikes are
                placeholders—select the actual contract and expiry.
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
                    <label>
                      Stock code {index + 1}
                      <input
                        required
                        value={leg.stockCode}
                        maxLength={30}
                        onChange={(event) =>
                          editLeg(index, {
                            stockCode: event.target.value.toUpperCase(),
                          })
                        }
                      />
                    </label>
                    <label>
                      Side {index + 1}
                      <select
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
                      </select>
                    </label>
                    <label>
                      Quantity units {index + 1}
                      <input
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
                    </label>
                    {definition.market === "options" && (
                      <>
                        <label>
                          Expiry {index + 1}
                          <input
                            type="date"
                            required
                            value={leg.expiryDate || ""}
                            onChange={(event) =>
                              editLeg(index, { expiryDate: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          Option type {index + 1}
                          <select
                            value={leg.right}
                            onChange={(event) =>
                              editLeg(index, {
                                right: event.target.value as Leg["right"],
                              })
                            }
                          >
                            <option value="call">Call</option>
                            <option value="put">Put</option>
                          </select>
                        </label>
                        <label>
                          Strike {index + 1}
                          <input
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
                        </label>
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
                <label>
                  Entry time (IST)
                  <input
                    type="time"
                    required
                    min="09:15"
                    max="15:20"
                    value={definition.entryTime}
                    onChange={(event) =>
                      edit({ ...definition, entryTime: event.target.value })
                    }
                  />
                </label>
                <label>
                  Exit time (IST)
                  <input
                    type="time"
                    required
                    min="09:20"
                    max="15:25"
                    value={definition.exitTime}
                    onChange={(event) =>
                      edit({ ...definition, exitTime: event.target.value })
                    }
                  />
                </label>
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
                  <label key={key}>
                    {label}
                    <input
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
                  </label>
                ))}
              </div>
              <p className="research-note">
                One intraday entry/exit. Stops and targets are observed at
                completed candle closes, then filled at the next open. Taxes,
                actual broker margin and leg execution risk are not modeled.
              </p>
              <Button type="submit">Save research strategy</Button>
            </fieldset>
          </form>
        </div>
      )}
      {tab === "simulator" && (
        <>
          <section className="panel">
            <span className="eyebrow">02 · REPLAY THE SESSION</span>
            <h2>Historical simulator</h2>
            <p>
              Connect your selected broker, select a saved strategy and a
              completed session. No generated prices or fallback data.
            </p>
            <div className="research-fields">
              <label>
                Historical session (IST)
                <input
                  type="date"
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                />
              </label>
              <label>
                Candle interval
                <select
                  value={interval}
                  onChange={(event) => setIntervalValue(event.target.value)}
                >
                  <option value="1minute">1 minute</option>
                  <option value="5minute">5 minutes</option>
                </select>
              </label>
            </div>
            <Button
              disabled={busy || !strategyId}
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
              {busy ? "Loading broker history…" : "Run historical simulation"}
            </Button>
            <label>
              Batch session dates (YYYY-MM-DD, comma separated)
              <input
                value={batchDays}
                onChange={(event) => setBatchDays(event.target.value)}
                placeholder="2025-01-02, 2025-01-03"
              />
            </label>
            <p>
              Up to 20 completed dates. Each day starts with the same capital;
              no compounding or overnight exposure. Missing history is skipped.
              Shared API budgets or the time limit can stop a batch early.
            </p>
            <Button
              disabled={busy || !strategyId || !batchDays.trim()}
              onClick={() =>
                void act(async () => {
                  const result = await researchRequest(
                    "/backtest/batch",
                    csrf,
                    "POST",
                    {
                      strategyId,
                      interval,
                      days: batchDays.split(",").map((value) => value.trim()),
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
            <label className="research-run-select">
              Saved replay
              <select
                aria-label="Saved replay"
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
              </select>
            </label>
          </section>
          {batch && (
            <section className="panel research-results">
              <h2>
                Independent daily batch · {batch.summary.sessionsRun} sessions
              </h2>
              <p>
                No compounding or overnight positions. Worst session drawdown is
                not continuous multi-day drawdown. Trade counts mean fills, not
                round trips.
              </p>
              <p>
                Net P&amp;L {currency(batch.summary.totalPnl)} · Fees{" "}
                {currency(batch.summary.totalFees)} · Worst session drawdown{" "}
                {currency(batch.summary.worstSessionDrawdown)}
              </p>
              <p>
                {batch.summary.winningSessions} winning ·{" "}
                {batch.summary.losingSessions} losing ·{" "}
                {batch.summary.breakEvenSessions} break-even sessions
              </p>
              <label>
                Batch replay session
                <select
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
                </select>
              </label>
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
                  <strong>{currency(run.pnl)}</strong>
                </div>
                <div>
                  <span>Max sampled drawdown</span>
                  <strong>{currency(run.drawdown)}</strong>
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
                  {point.open ? "Basket open" : "Flat"} · {currency(point.pnl)}
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
                values={run.points.slice(0, cursor + 1).map((item) => item.pnl)}
                label="Historical basket P&L up to the replay cursor"
              />
              <p>
                {point.prices
                  .map((price, index) => `Leg ${index + 1}: ${currency(price)}`)
                  .join(" · ")}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time IST</th>
                      <th>Leg</th>
                      <th>Side</th>
                      <th>Units</th>
                      <th>Fill</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.fills
                      .filter((fill) => fill.time <= point.time)
                      .map((fill, index) => (
                        <tr key={index}>
                          <td>{timeLabel(fill.time)}</td>
                          <td>{fill.leg + 1}</td>
                          <td>{fill.action}</td>
                          <td>{fill.quantity}</td>
                          <td>{currency(fill.price)}</td>
                          <td>{fill.reason}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <ul className="research-note">
                {run.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {tab === "quotes" && (
        <section className="panel">
          <span className="eyebrow">03 · OBSERVE, THEN REVIEW</span>
          <h2>Live data preview</h2>
          <p>
            Kotak uses real quote snapshots or optional 15-second polling.
            Basket prices are not atomic; old exchange timestamps are marked
            stale.
          </p>
          <Button
            disabled={busy || !strategyId || kotakPolling}
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
                  disabled={busy || !strategyId || kotakPolling}
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
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Leg</th>
                      <th>Last</th>
                      <th>Bid</th>
                      <th>Ask</th>
                      <th>Last trade IST</th>
                      <th>Freshness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quotes.map((quote, index) => (
                      <tr key={index}>
                        <td>
                          {index + 1} · {quote.stockCode}
                        </td>
                        <td>{currency(quote.price)}</td>
                        <td>{currency(quote.bid)}</td>
                        <td>{currency(quote.ask)}</td>
                        <td>
                          {quote.observedAt
                            ? timeLabel(quote.observedAt)
                            : "Unavailable"}
                        </td>
                        <td>
                          {quote.stale ||
                          !quote.observedAt ||
                          clock - quote.observedAt > 60000 ||
                          (quote.receivedAt !== undefined &&
                            clock - quote.receivedAt > 30000)
                            ? "STALE — refresh"
                            : "Recent"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
