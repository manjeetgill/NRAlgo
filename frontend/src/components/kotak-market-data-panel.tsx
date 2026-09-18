"use client";

/** Read-only market explorer. Broker credentials and WebSocket authentication stay server-side.
 * The JSON inspector intentionally shows validated wire fields for learning/debugging; large
 * history displays are capped, with a local download of the full sanitized result available.
 */
import { useEffect, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";

const tools = [
  "instruments",
  "quotes",
  "expiries",
  "chain",
  "history",
  "stream",
] as const;
type Tool = (typeof tools)[number];
type Result = Record<string, unknown>;
const toolLabels: Record<Tool, string> = {
  instruments: "Instruments",
  quotes: "Quotes",
  expiries: "Expiries",
  chain: "Option / futures chain",
  history: "History",
  stream: "WebSocket stream",
};
const quoteSegments = ["nse_cm", "bse_cm", "nse_fo", "bse_fo", "cde_fo"];
const derivativeSegments = ["nse_fo", "bse_fo", "mcx_fo"];
const historySegments = ["nse_cm", "nse_fo", "bse_cm", "bse_fo"];
const streamSegments = [
  "nse_cm",
  "nse_fo",
  "cde_fo",
  "nse_com",
  "bse_cm",
  "bse_fo",
  "bse_cd",
  "bse_co",
  "mcx_fo",
  "ncd_co",
];

/** Each Kotak endpoint supports a different exchange list. This only controls the form;
 * the backend independently validates the selection before making a broker request.
 */
function getSupportedExchanges(selectedTool: Tool) {
  switch (selectedTool) {
    case "expiries":
    case "chain":
      return derivativeSegments;
    case "history":
      return historySegments;
    case "stream":
      return streamSegments;
    default:
      return quoteSegments;
  }
}

/** Avoid rendering thousands of candle rows. The download still includes the full response. */
function getResultPreview(result: Result | null) {
  if (!result || !Array.isArray(result.candles)) return result;
  return {
    ...result,
    totalCandles: result.candles.length,
    candles: result.candles.slice(0, 200),
    displayNote:
      "First 200 rows shown. Download includes every returned candle.",
  };
}

/** Stop and release the socket on navigation; hidden views stop lease polling automatically. */
export function KotakMarketDataPanel({
  csrf,
  prefilledInstruments = [],
  initialTool = "quotes",
}: {
  csrf: string;
  prefilledInstruments?: string[];
  /** Initial navigation intent from Overview; selection remains local after this panel mounts. */
  initialTool?: Tool;
}) {
  // Honor the caller's research shortcut and select an exchange supported by that tool.
  const [selectedTool, setSelectedTool] = useState<Tool>(initialTool);
  const [exchange, setExchange] = useState(
    getSupportedExchanges(initialTool)[0],
  );
  const [instrumentInput, setInstrumentInput] = useState(
    prefilledInstruments.join(",") || "Nifty 50",
  );
  useEffect(() => {
    if (prefilledInstruments.length)
      setInstrumentInput(prefilledInstruments.join(","));
  }, [prefilledInstruments.join(",")]);
  const [underlying, setUnderlying] = useState("NIFTY");
  const [instrumentType, setInstrumentType] = useState("option");
  const [expiry, setExpiry] = useState("");
  const [strikeCount, setStrikeCount] = useState("40");
  const [quoteFilter, setQuoteFilter] = useState("all");
  const [interval, setCandleInterval] = useState("5min");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [streamDetail, setStreamDetail] = useState("indices");
  const [initialStreamAction, setInitialStreamAction] = useState("subscribe");
  const [marketDataResult, setMarketDataResult] = useState<Result | null>(null);
  const [streamSnapshot, setStreamSnapshot] = useState<Result | null>(null);
  const [isPollingStream, setIsPollingStream] = useState(false);
  const [isRequestPending, setIsRequestPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const segments = getSupportedExchanges(selectedTool);

  // The feed is shared with the overview. The server viewer lease owns cleanup.

  useEffect(() => {
    if (!isPollingStream) return;
    // Cleanup marks in-flight requests as obsolete; their results must not update a new view.
    let cancelled = false;
    let pending = false;
    const timer = setInterval(async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const snapshot = await requestApiJson("/market/kotak/feed");
        if (cancelled) return;
        setStreamSnapshot(snapshot);
        if (
          [
            "error",
            "stopped",
            "disconnected",
            "session-expired",
            "authentication-failed",
          ].includes(snapshot.state)
        )
          setIsPollingStream(false);
      } catch (failure) {
        if (!cancelled) {
          setErrorMessage(
            failure instanceof Error ? failure.message : "Feed unavailable.",
          );
          setIsPollingStream(false);
        }
      } finally {
        pending = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isPollingStream]);

  /** Build the exact JSON expected by the backend. Keep wire names such as "from" and
   * "count" here; form state can use clearer names without changing the API contract.
   */
  function buildMarketDataRequest(
    instruments: { exchange: string; instrument: string }[],
  ) {
    switch (selectedTool) {
      case "instruments":
        return { operation: "instruments" };
      case "quotes":
        return { operation: "quotes", instruments, filter: quoteFilter };
      case "history":
        return {
          operation: "history",
          exchange,
          instrument: instrumentInput.trim(),
          from: startDate,
          to: endDate,
          interval,
        };
      case "expiries":
        return { operation: "expiries", exchange, underlying, instrumentType };
      case "chain": {
        const request: Record<string, unknown> = {
          operation: "chain",
          exchange,
          underlying,
          instrumentType,
          count: Number(strikeCount),
        };
        // Omitting expiry asks Kotak for its default; sending an empty date is invalid.
        if (expiry) request.expiry = expiry;
        return request;
      }
      default:
        throw new Error("Streaming uses its own endpoint.");
    }
  }

  /** Make one user-requested fetch. Streams use a separate endpoint and poll only the
   * backend cache afterwards. Neither path submits an order or automatically retries.
   */
  async function fetchSelectedMarketData() {
    setIsRequestPending(true);
    setErrorMessage("");
    setMarketDataResult(null);
    const instruments = instrumentInput
      .split(",")
      .map((instrument) => ({ exchange, instrument: instrument.trim() }));
    try {
      if (selectedTool === "stream") {
        setStreamSnapshot(
          await requestApiJson(
            "/market/kotak/feed",
            "POST",
            { kind: streamDetail, mode: initialStreamAction, instruments },
            csrf,
          ),
        );
        setIsPollingStream(true);
      } else {
        const request = buildMarketDataRequest(instruments);
        setMarketDataResult(
          await requestApiJson(
            "/market/kotak/read",
            "POST",
            request,
            csrf,
            20000,
          ),
        );
      }
    } catch (failure) {
      setErrorMessage(
        failure instanceof Error ? failure.message : "Market data unavailable.",
      );
    } finally {
      setIsRequestPending(false);
    }
  }

  /** Subscription controls operate on the active set, not unsaved input edits. */
  async function updateStreamSubscription(
    action: "stop" | "subscribe" | "unsubscribe" | "snapshot",
  ) {
    setIsRequestPending(true);
    setErrorMessage("");
    try {
      let snapshot: Result;
      if (action === "stop") {
        snapshot = await requestApiJson(
          "/market/kotak/feed",
          "DELETE",
          undefined,
          csrf,
        );
      } else {
        snapshot = await requestApiJson(
          "/market/kotak/feed/control",
          "POST",
          { action },
          csrf,
        );
      }
      setStreamSnapshot(snapshot);
      setIsPollingStream(action !== "stop");
    } catch (failure) {
      setErrorMessage(
        failure instanceof Error ? failure.message : "Feed control failed.",
      );
    } finally {
      setIsRequestPending(false);
    }
  }

  /** The download is generated locally from sanitized data already visible to this user. */
  function downloadMarketDataJson() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(marketDataResult, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `kotak-${selectedTool}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const displayed =
    selectedTool === "stream" ? streamSnapshot : marketDataResult;
  const preview = getResultPreview(displayed);

  return (
    <section className="panel" aria-label="Kotak market data explorer">
      <div className="panel-heading">
        <div>
          <h2>Kotak market data</h2>
          <p>
            Connect under Brokers first. Read-only data; this screen cannot
            place real or paper orders.
          </p>
        </div>
      </div>
      <div className="market-data-content">
        <div className="market-data-actions" aria-label="Market data tools">
          {tools.map((name) => (
            <Button
              key={name}
              variant={selectedTool === name ? "primary" : "secondary"}
              disabled={isRequestPending}
              aria-pressed={selectedTool === name}
              onClick={() => {
                if (selectedTool === "stream" && name !== "stream") {
                  setIsPollingStream(false);
                }
                setSelectedTool(name);
                setMarketDataResult(null);
                setErrorMessage("");
                setExchange(
                  name === "expiries" || name === "chain" ? "nse_fo" : "nse_cm",
                );
              }}
            >
              {toolLabels[name]}
            </Button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void fetchSelectedMarketData();
          }}
        >
          <div className="market-data-fields">
            {selectedTool !== "instruments" && (
              <label>
                Market exchange
                <select
                  value={exchange}
                  onChange={(event) => setExchange(event.target.value)}
                >
                  {segments.map((segment) => (
                    <option key={segment}>{segment}</option>
                  ))}
                </select>
              </label>
            )}
            {["quotes", "history", "stream"].includes(selectedTool) && (
              <label>
                Instrument token(s) / index name
                <input
                  value={instrumentInput}
                  onChange={(event) => setInstrumentInput(event.target.value)}
                  required
                />
                <small>
                  {selectedTool === "history"
                    ? "One numeric pSymbol token."
                    : selectedTool === "stream"
                      ? "Up to 100 comma-separated tokens; this feed is shared with Overview."
                      : "Up to 50 comma-separated tokens. Quotes/indices accept exact case-sensitive index names."}
                </small>
              </label>
            )}
            {selectedTool === "quotes" && (
              <label>
                Quote filter
                <select
                  value={quoteFilter}
                  onChange={(event) => setQuoteFilter(event.target.value)}
                >
                  {[
                    "all",
                    "52W",
                    "scrip_details",
                    "circuit_limits",
                    "ohlc",
                    "oi",
                    "depth",
                    "ltp",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            )}
            {(selectedTool === "expiries" || selectedTool === "chain") && (
              <>
                <label>
                  Market underlying
                  <input
                    required
                    value={underlying}
                    onChange={(event) => setUnderlying(event.target.value)}
                  />
                </label>
                <label>
                  Instrument type
                  <select
                    value={instrumentType}
                    onChange={(event) => setInstrumentType(event.target.value)}
                  >
                    <option value="option">Options</option>
                    <option value="fut">Futures</option>
                  </select>
                </label>
              </>
            )}
            {selectedTool === "chain" && (
              <>
                <label>
                  Expiry (optional)
                  <input
                    type="date"
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                  />
                </label>
                <label>
                  Strike count
                  <input
                    type="number"
                    min="10"
                    max="100"
                    step="10"
                    value={strikeCount}
                    onChange={(event) => setStrikeCount(event.target.value)}
                  />
                </label>
              </>
            )}
            {selectedTool === "history" && (
              <>
                <label>
                  From date
                  <input
                    type="date"
                    required
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </label>
                <label>
                  To date
                  <input
                    type="date"
                    required
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </label>
                <label>
                  Candle interval
                  <select
                    value={interval}
                    onChange={(event) => setCandleInterval(event.target.value)}
                  >
                    {[
                      "1min",
                      "3min",
                      "5min",
                      "10min",
                      "15min",
                      "30min",
                      "60min",
                      "D",
                      "W",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {selectedTool === "stream" && (
              <>
                <label>
                  Feed detail
                  <select
                    value={streamDetail}
                    onChange={(event) => setStreamDetail(event.target.value)}
                  >
                    {["indices", "mini", "touchline", "depth"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Initial feed request
                  <select
                    value={initialStreamAction}
                    onChange={(event) =>
                      setInitialStreamAction(event.target.value)
                    }
                  >
                    <option value="subscribe">Subscribe</option>
                    <option value="snapshot">One snapshot</option>
                  </select>
                </label>
              </>
            )}
          </div>
          {selectedTool === "instruments" && (
            <p>
              Discover all seven supported master CSV files. NSE searchable
              dropdowns remain in Broker paper; other files are read-only
              reference downloads.
            </p>
          )}
          {selectedTool === "history" && (
            <p>
              Active contracts only. Maximum inclusive ranges: 1/3/5min → 30
              days; 10/15min → 60; 30/60min → 90; D/W → 180. Research replays
              remain 1/5-minute sessions.
            </p>
          )}
          {selectedTool === "chain" && (
            <p>
              Blank expiry uses the nearest options expiry or all futures
              expiries. Native chain prices are indicative, without bid/ask or
              exchange timestamps.
            </p>
          )}
          {selectedTool === "stream" && (
            <p>
              One shared server-side feed, up to 100 instruments. Reconnect
              explicitly after an error. The active set is shown below; editing
              fields does not change it. Hidden/closed views release the feed
              after 45 seconds.
            </p>
          )}
          <Button type="submit" disabled={isRequestPending}>
            {isRequestPending
              ? "Requesting…"
              : selectedTool === "stream"
                ? "Start / reconnect feed"
                : "Fetch market data"}
          </Button>
        </form>
        {selectedTool === "stream" && streamSnapshot && (
          <div className="market-data-actions">
            {(["subscribe", "unsubscribe", "snapshot", "stop"] as const).map(
              (action) => (
                <Button
                  key={action}
                  variant="secondary"
                  disabled={isRequestPending}
                  onClick={() => void updateStreamSubscription(action)}
                >
                  {action === "stop"
                    ? "Stop feed"
                    : `${action[0].toUpperCase()}${action.slice(1)} active set`}
                </Button>
              ),
            )}
          </div>
        )}
        {errorMessage && (
          <p className="error" role="alert">
            {errorMessage}
          </p>
        )}
        {marketDataResult &&
          selectedTool === "instruments" &&
          Array.isArray(marketDataResult.files) && (
            <ul>
              {(
                marketDataResult.files as {
                  exchange: string;
                  date: string;
                  url: string;
                }[]
              ).map((file) => (
                <li key={file.exchange}>
                  <a href={file.url} target="_blank" rel="noreferrer">
                    {file.exchange} master · {file.date}
                  </a>
                </li>
              ))}
            </ul>
          )}
        {marketDataResult && (
          <Button variant="secondary" onClick={downloadMarketDataJson}>
            Download result JSON
          </Button>
        )}
        {preview && (
          <pre className="market-data-result" aria-label="Market data result">
            {JSON.stringify(preview, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}
