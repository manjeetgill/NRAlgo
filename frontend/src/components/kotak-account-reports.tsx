"use client";
/** Selected broker-owned account fields only. Reports never modify the separate paper ledger. */
import { useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "./ui/button";
import { LiveOptionChain, type LiveTick } from "./live-option-chain";
type Report = {
  rows: Record<string, string | number | null>[] | null;
  error: string | null;
};
type Reports = Record<"limits" | "positions" | "orders" | "trades", Report> & {
  observedAt?: number;
};
const rupees = (value: number | null) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
      }).format(value);
export function KotakAccountReports({
  csrf,
  autoRefresh = false,
  loadOnMount = false,
  summaryOnly = false,
  onOpenMarket,
}: {
  csrf: string;
  /** The server caches broker calls, so this may safely update the UI each second. */
  autoRefresh?: boolean;
  /** Load one broker snapshot when this live view opens; it never starts a polling loop. */
  loadOnMount?: boolean;
  /** Overview shows live headline metrics only; position details live on their own tab. */
  summaryOnly?: boolean;
  onOpenMarket?: (instruments: string[]) => void;
}) {
  const [data, setData] = useState<Reports | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [showPositions, setShowPositions] = useState(false);
  const requestInFlight = useRef(false);
  const [showChain, setShowChain] = useState(false);
  const [ticks, setTicks] = useState<LiveTick[]>([]);
  const [feedStatus, setFeedStatus] = useState("Waiting for position snapshot");
  const limits = data?.limits?.rows?.[0];
  const positions = (data?.positions?.rows ?? []).filter(
    (row) => row.quantity !== 0,
  );
  const positionPnl = positions.reduce<number | null>((total, position) => {
    const value = position.pnl;
    return typeof value === "number" ? (total ?? 0) + value : total;
  }, null);
  const livePnl =
    data?.positions?.rows &&
    positions.every((row) => typeof row.pnl === "number")
      ? (positionPnl ?? 0)
      : null;
  /** Load explicitly and clear old data first; unavailable values must not appear as zero. */
  async function refresh(manual = true) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (manual) setBusy(true);
    if (manual) setData(null);
    setError("");
    try {
      setData(
        await requestApiJson(
          "/brokers/kotak/overview",
          "POST",
          {},
          csrf,
          95000,
        ),
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      requestInFlight.current = false;
      if (manual) setBusy(false);
    }
  }
  useEffect(() => {
    if (!autoRefresh && !loadOnMount) return;
    void refresh(false);
    if (!autoRefresh) return;
    const timer = setInterval(() => void refresh(false), 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, loadOnMount, csrf]);
  useEffect(() => {
    if (!data) return;
    if (
      data.positions?.rows?.length &&
      !data.positions.rows.some((row) => row.instrumentToken)
    ) {
      setFeedStatus(
        data.positions?.rows?.length
          ? "The running API is missing instrument tokens. Restart the backend and reconnect Kotak."
          : "No open contracts to stream",
      );
      return;
    }
    let cancelled = false;
    let pending = false;
    setFeedStatus("Connecting to Kotak live feed…");
    let startupError = "";
    if (data.positions?.rows?.some((row) => row.quantity !== 0))
      void requestApiJson("/market/live-feed", "POST", {}, csrf).catch(
        (failure) => {
          startupError = (failure as Error).message;
          if (!cancelled) setFeedStatus(startupError);
        },
      );
    const timer = setInterval(async () => {
      if (cancelled || document.hidden || pending) return;
      pending = true;
      try {
        const snapshot = await requestApiJson("/market/feed");
        if (cancelled) return;
        setFeedStatus(
          snapshot.state === "stopped" && startupError
            ? startupError
            : `${snapshot.state}: ${snapshot.detail || "Waiting for ticks"}`,
        );
        const records = Array.isArray(snapshot.records) ? snapshot.records : [];
        const fresh = records.filter(
          (tick: LiveTick) =>
            tick.receivedRecently && typeof tick.ltp === "number",
        );
        if (fresh.length)
          setFeedStatus(
            `Receiving prices · ${fresh.length} contracts · latest tick ${new Date(Math.max(...fresh.map((tick: LiveTick) => tick.receivedAt ?? 0))).toLocaleTimeString("en-IN")}`,
          );
        setTicks(records);
        setData((previous) => {
          if (!previous?.positions.rows) return previous;
          return {
            ...previous,
            positions: {
              ...previous.positions,
              rows: previous.positions.rows.map((position) => {
                const tick = records.find(
                  (record: Record<string, unknown>) =>
                    record.exchange === position.exchange &&
                    String(record.instrument) ===
                      String(position.instrumentToken),
                ) as Record<string, unknown> | undefined;
                const mark = typeof tick?.ltp === "number" ? tick.ltp : NaN;
                if (
                  tick?.receivedRecently !== true ||
                  !Number.isFinite(mark) ||
                  typeof position.pnlPerMark !== "number"
                )
                  return position;
                const slope =
                  typeof position.pnlPerMark === "number"
                    ? position.pnlPerMark
                    : Number(position.quantity);
                return {
                  ...position,
                  pnl:
                    typeof position.pnlBase === "number"
                      ? position.pnlBase + mark * slope
                      : typeof position.pnl === "number" &&
                          typeof position.markPrice === "number"
                        ? position.pnl + (mark - position.markPrice) * slope
                        : null,
                  markPrice: mark,
                  markUpdatedAt:
                    typeof tick.receivedAt === "number"
                      ? tick.receivedAt
                      : null,
                };
              }),
            },
          };
        });
      } catch (failure) {
        if (!cancelled) setFeedStatus((failure as Error).message);
      } finally {
        pending = false;
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [data?.observedAt, csrf]);
  return (
    <section className="kotak-data-panel" aria-label="Kotak account reports">
      <h3>Kotak funds and open positions — read only</h3>
      <p role="status">Price feed: {feedStatus}</p>
      <p>
        Real broker records. Monetary fields are INR. Each open position is
        marked from its exact Kotak instrument token. Order and trade-history
        reports are not requested; no orders are sent from this view.
      </p>
      <Button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy
          ? "Loading Kotak reports…"
          : autoRefresh
            ? "Refresh now · auto-refreshing every second"
            : data
              ? "Refresh position marks and P&L"
              : "Load live positions and marks"}
      </Button>
      {data?.observedAt && (
        <p role="status">
          Latest broker snapshot:{" "}
          {new Date(data.observedAt).toLocaleTimeString("en-IN")}
        </p>
      )}
      {data && (
        <section className="live-summary" aria-label="Live account summary">
          <article>
            <span>Position P&amp;L</span>
            <strong
              className={
                livePnl !== null && livePnl < 0 ? "negative" : "positive"
              }
            >
              {rupees(livePnl)}
            </strong>
            <small>
              Open contracts · includes realised P&amp;L within each position ·
              check feed status for freshness
            </small>
          </article>
          <article>
            <span>Available margin</span>
            <strong>
              {rupees(
                typeof limits?.available === "number" ? limits.available : null,
              )}
            </strong>
            <small>Broker-reported available funds</small>
          </article>
          <button
            type="button"
            className="live-summary-position"
            aria-expanded={showPositions}
            onClick={() => {
              setShowPositions((open) => !open);
              if (!data) void refresh(false);
            }}
          >
            <span>Open positions</span>
            <strong>
              {data.positions?.rows ? positions.length : "Unavailable"}
            </strong>
            <small>
              Click to {showPositions ? "hide" : "view"} position marks and
              P&amp;L
            </small>
          </button>
        </section>
      )}
      {summaryOnly && showPositions && data && (
        <section
          className="live-position-detail"
          aria-label="Open position details"
        >
          <h4>Open positions</h4>
          {!data.positions?.rows ? (
            <p>
              Position data is unavailable. It is not assumed to be an empty
              account.
            </p>
          ) : !positions.length ? (
            <p>No non-zero Kotak positions in this snapshot.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Quantity</th>
                    <th>Average</th>
                    <th>Current mark</th>
                    <th>Position P&amp;L</th>
                    <th>Last price update</th>
                  </tr>
                </thead>
                <tbody>
                  {positions
                    .filter((position) => position.quantity !== 0)
                    .map((position, index) => (
                      <tr key={index}>
                        <td>{position.symbol}</td>
                        <td>{position.quantity}</td>
                        <td>
                          {rupees(
                            typeof position.averagePrice === "number"
                              ? position.averagePrice
                              : null,
                          )}
                        </td>
                        <td>
                          {rupees(
                            typeof position.markPrice === "number"
                              ? position.markPrice
                              : null,
                          )}
                        </td>
                        <td
                          className={
                            typeof position.pnl === "number" && position.pnl < 0
                              ? "negative"
                              : "positive"
                          }
                        >
                          {rupees(
                            typeof position.pnl === "number"
                              ? position.pnl
                              : null,
                          )}
                        </td>
                        <td>
                          {typeof position.markUpdatedAt === "number"
                            ? new Date(
                                position.markUpdatedAt,
                              ).toLocaleTimeString("en-IN")
                            : "Initial snapshot"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {summaryOnly && data && onOpenMarket && (
        <Button
          type="button"
          variant="secondary"
          aria-expanded={showChain}
          onClick={() => setShowChain((open) => !open)}
        >
          Open live feed / option chain
        </Button>
      )}
      {showChain && (
        <LiveOptionChain
          csrf={csrf}
          ticks={ticks}
          positionStrikes={positions.map((row) => ({
            symbol: String(row.symbol),
            strike: Number(row.strike),
          }))}
        />
      )}
      {data?.positions?.error && <p role="alert">{data.positions.error}</p>}
      {error && <p role="alert">{error}</p>}
      {!summaryOnly &&
        data &&
        (["limits", "positions"] as const).map((kind) => {
          // Keep the Overview usable while a deployed API is being restarted
          // after this client adds a new report section.
          const report = data[kind] ?? {
              rows: null,
              error:
                "Kotak positions are unavailable until the server refreshes.",
            },
            columns =
              kind === "limits"
                ? [
                    "available",
                    "marginUsed",
                    "collateral",
                    "realizedPnl",
                    "unrealizedPnl",
                  ]
                : kind === "positions"
                  ? [
                      "symbol",
                      "exchange",
                      "product",
                      "quantity",
                      "averagePrice",
                      "markPrice",
                      "pnl",
                    ]
                  : [
                      "orderId",
                      "symbol",
                      "exchange",
                      "side",
                      "status",
                      "quantity",
                      "price",
                      "filledQuantity",
                      "time",
                    ];
          return (
            <div key={kind}>
              <h4>{kind}</h4>
              {report.error ? (
                <p role="alert">{report.error}</p>
              ) : (
                <>
                  <p>{report.rows?.length} records returned</p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          {columns.map((key) => (
                            <th key={key}>{key}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.rows?.map((row, index) => (
                          <tr key={index}>
                            {columns.map((key) => (
                              <td key={key}>{row[key] ?? "Unavailable"}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          );
        })}
    </section>
  );
}
