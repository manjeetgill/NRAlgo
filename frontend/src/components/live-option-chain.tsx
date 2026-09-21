"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApiJson } from "@/lib/api";
import type { BrokerInstrument } from "./instrument-picker";
import { Button } from "./ui/button";
import dynamic from "next/dynamic";
import {
  useOptionChain,
  type ChainContract,
  type LiveTick,
  type OptionChainSnapshot,
} from "@/features/option-chain/use-option-chain";
import { useOptionGreeks } from "@/features/option-chain/use-option-greeks";

export type {
  ChainContract,
  LiveTick,
} from "@/features/option-chain/use-option-chain";

/** Load the canvas library only when a user opens a contract chart; never render it on the server. */
const ContractPriceChart = dynamic(
  () => import("@/features/option-chain/contract-price-chart"),
  {
    ssr: false,
    loading: () => <p role="status">Loading chart…</p>,
  },
);

type Contract = ChainContract;
/** A stable empty dependency prevents price renders from reloading the broker chain. */
const EMPTY_POSITION_STRIKES: { symbol: string; strike: number }[] = [];
type Chain = OptionChainSnapshot;
const amount = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "—";

/** Centre the first stored page around spot without adding broker quote requests. */
function historicalAtmOffset(chain: Chain): number {
  if (Number.isSafeInteger(chain.atmOffset) && chain.atmOffset! >= 0) {
    return chain.atmOffset!;
  }
  if (
    chain.dataMode !== "historical" ||
    typeof chain.underlyingPrice !== "number" ||
    chain.underlyingPrice <= 0
  ) {
    return 0;
  }
  const strikes = [
    ...new Set(
      chain.items
        .map((item) => item.option?.strikePrice)
        .filter((strike): strike is number => typeof strike === "number"),
    ),
  ].sort((left, right) => left - right);
  if (strikes.length < 2) {
    return 0;
  }
  const step = strikes[1] - strikes[0];
  const contractsPerStrike = Math.max(
    1,
    Math.round(chain.items.length / strikes.length),
  );
  if (!Number.isFinite(step) || step <= 0) {
    return 0;
  }
  const visibleStrikeCount = Math.max(
    1,
    Math.floor(chain.items.length / contractsPerStrike),
  );
  const targetFirstStrike =
    chain.underlyingPrice - Math.floor(visibleStrikeCount / 2) * step;
  const strikeShift = Math.max(
    0,
    Math.round((targetFirstStrike - strikes[0]) / step),
  );
  const maximumOffset = Math.max(0, chain.total - chain.items.length);
  const candidate = strikeShift * contractsPerStrike;
  return Math.min(
    maximumOffset - (maximumOffset % contractsPerStrike),
    candidate - (candidate % contractsPerStrike),
  );
}

/** One master/quote snapshot per selection. Subsequent marks share the overview's tick batch. */
export function LiveOptionChain({
  csrf,
  ticks,
  positionStrikes = EMPTY_POSITION_STRIKES,
  activeLegs = [],
  onAddLeg,
  compact = false,
  selectedUnderlying,
  experience,
  asOf,
  onDataMode,
  onReferenceData,
  onExpiryChange,
  onTrade,
  analytics = false,
  essentialColumns = false,
  initialExpiry,
}: {
  csrf: string;
  ticks: LiveTick[];
  positionStrikes?: { symbol: string; strike: number }[];
  activeLegs?: ReadonlyArray<{
    stockCode?: string;
    expiryDate?: string;
    strikePrice?: number;
    right?: "call" | "put";
    side: "buy" | "sell";
  }>;
  onAddLeg?: (contract: ChainContract, side: "buy" | "sell") => string;
  compact?: boolean;
  selectedUnderlying?: string;
  experience?: "builder" | "chain";
  asOf?: string;
  onDataMode?: (mode: "live" | "historical") => void;
  /** Invalidate parent research context immediately when the user selects another expiry. */
  onExpiryChange?: () => void;
  onReferenceData?: (reference: {
    spot: number;
    day?: string;
    expiry?: string;
  }) => void;
  onTrade?: (contract: ChainContract, side: "buy" | "sell") => void;
  analytics?: boolean;
  essentialColumns?: boolean;
  initialExpiry?: string;
}) {
  const detailDialog = useRef<HTMLDialogElement>(null);
  const [selectedToken, setSelectedToken] = useState("");
  const [showChart, setShowChart] = useState(false);
  const [draftError, setDraftError] = useState("");
  // Removing/resetting legs changes the guard's premise; do not retain a rejected-add error.
  useEffect(() => {
    setDraftError("");
  }, [activeLegs.length]);
  const [index, setIndex] = useState("NIFTY");
  const [members, setMembers] = useState<{
    index: string;
    symbols: string[];
  } | null>(null);
  const [memberError, setMemberError] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [underlying, setUnderlying] = useState(selectedUnderlying || "NIFTY");
  const [expiry, setExpiry] = useState("");
  const [expiries, setExpiries] = useState<string[]>([]);
  const [chain, setChain] = useState<Chain | null>(null);
  const [sourceInfo, setSourceInfo] = useState<
    Pick<Chain, "source" | "dataMode" | "observedAt">
  >({ dataMode: undefined });
  const [offset, setOffset] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searchError, setSearchError] = useState("");
  const [feedError, setFeedError] = useState("");
  const generation = useRef(0);
  const appendNextPage = useRef(false);
  // React strict-mode remounts and fast selections must not overlap broker operations.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const read = useCallback(
    (path: string, body: unknown) => {
      const next = queue.current
        .catch(() => {})
        .then(() => requestApiJson(path, "POST", body, csrf, 95000));
      queue.current = next;
      return next;
    },
    [csrf],
  );
  /** Add the workspace policy to discovery reads; legacy live screens omit it. */
  const workspaceBody = useCallback(
    (body: Record<string, unknown>) => ({
      ...body,
      ...(experience ? { experience } : {}),
      ...(asOf ? { asOf } : {}),
    }),
    [experience, asOf],
  );

  /** Resolve official index membership on selection; abort the previous HTTP read on change/unmount. */
  useEffect(() => {
    if (selectedUnderlying) {
      return;
    }
    const controller = new AbortController();
    setMembers(null);
    setMemberError("");
    void (async () => {
      try {
        const response = await fetch(
          `/reference/index-constituents?index=${encodeURIComponent(index)}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "Index constituents unavailable");
        }
        if (
          result.index !== index ||
          !Array.isArray(result.symbols) ||
          !result.symbols.every((symbol: unknown) => typeof symbol === "string")
        ) {
          throw new Error("Invalid index constituents");
        }
        if (!controller.signal.aborted) {
          setMembers(result);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setMemberError((failure as Error).message);
        }
      }
    })();
    return () => controller.abort();
  }, [index, selectedUnderlying]);

  const eligibleStocks =
    members?.index === index
      ? members.symbols.filter((symbol) => symbols.includes(symbol))
      : [];

  /** Load broker-supported underlying facets once per session; ignore a departed screen's promise. */
  useEffect(() => {
    if (selectedUnderlying) {
      return;
    }
    let cancelled = false;
    setSearchError("");
    void (async () => {
      try {
        // Every NSE call trading symbol ends in CE. Facets cover the matching
        // master, not just the 50 returned contracts, so this prefills symbols.
        const result = await read(
          "/market/instruments",
          workspaceBody({
            market: "options",
            query: "CE",
            offset: 0,
          }),
        );
        if (!cancelled) {
          setSymbols(result.underlyings);
        }
      } catch (failure) {
        if (!cancelled) {
          setSearchError((failure as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [read, selectedUnderlying, workspaceBody]);

  /** Replace expiries when the underlying changes, fencing old results before selecting the first expiry. */
  useEffect(() => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setChain(null);
    setExpiries([]);
    setExpiry("");
    setOffset(-1);
    appendNextPage.current = false;
    void read("/market/option-chain", workspaceBody({ underlying, offset: 0 }))
      .then((result) => {
        if (current !== generation.current) {
          return;
        }
        setExpiries(result.expiries);
        setExpiry(
          initialExpiry && result.expiries.includes(initialExpiry)
            ? initialExpiry
            : result.expiries[0] || "",
        );
        setSourceInfo({
          source: result.source,
          dataMode: result.dataMode,
          observedAt: result.observedAt,
        });
        if (result.dataMode) {
          onDataMode?.(result.dataMode);
        }
        if (!result.expiries.length) {
          setError(
            result.dataMode === "historical"
              ? "No stored option-chain snapshot exists for this scrip yet."
              : "No current expiries found for this underlying.",
          );
        }
      })
      .catch((failure) => {
        if (current === generation.current) {
          setError(failure.message);
        }
      })
      .finally(() => {
        if (current === generation.current) {
          setBusy(false);
        }
      });
    return () => {
      generation.current = current + 1;
    };
  }, [underlying, read, workspaceBody, onDataMode, initialExpiry]);

  /** Load one strike page and subscribe its contracts; cleanup invalidates results without stopping the shared feed. */
  useEffect(() => {
    if (!expiry) {
      return;
    }
    const current = ++generation.current;
    const shouldAppend = appendNextPage.current && offset >= 0;
    setBusy(true);
    setError("");
    setFeedError("");
    if (!shouldAppend) {
      setChain(null);
    }
    void (async () => {
      try {
        let start = offset;
        if (start < 0 && !experience) {
          // The master resolves exact identities even when native chain quotes are unavailable.
          // Seek around an open position (or the middle of the listed strikes), never the first deep-ITM page.
          const search = (start: number) =>
            read(
              "/market/instruments",
              workspaceBody({
                market: "options",
                query: underlying,
                underlying,
                expiryDate: expiry,
                offset: start,
              }),
            );
          const first = await search(0);
          const target = positionStrikes.find(
            (p) =>
              p.symbol.startsWith(underlying) &&
              /^\d/.test(p.symbol.slice(underlying.length)) &&
              p.strike > 0,
          )?.strike;
          start = Math.max(0, Math.floor(first.total / 2) - 24);
          if (target && first.total) {
            let low = 0,
              high = Math.ceil(first.total / 50) - 1;
            while (low <= high) {
              const page = Math.floor((low + high) / 2);
              const rows = page === 0 ? first : await search(page * 50);
              const index = rows.items.findIndex(
                (item: BrokerInstrument) =>
                  (item.option?.strikePrice ?? 0) >= target,
              );
              if (index === -1) {
                low = page + 1;
              } else {
                start = Math.max(0, page * 50 + index - 24);
                high = page - 1;
              }
            }
          }
          start -= start % 2;
        }
        if (start < 0) {
          start = 0;
        }
        let result: Chain = await read(
          "/market/option-chain",
          workspaceBody({
            underlying,
            expiryDate: expiry,
            offset: start,
          }),
        );
        if (offset < 0 && experience && result.dataMode === "historical") {
          const centredOffset = historicalAtmOffset(result);
          if (centredOffset > 0) {
            start = centredOffset;
            result = await read(
              "/market/option-chain",
              workspaceBody({
                underlying,
                expiryDate: expiry,
                offset: centredOffset,
              }),
            );
          }
        }
        if (current !== generation.current) {
          return;
        }
        setChain((previous) => {
          if (!shouldAppend || !previous) {
            return result;
          }
          const contracts = new Map(
            previous.items.map((item) => [item.instrument, item]),
          );
          result.items.forEach((item) => contracts.set(item.instrument, item));
          return {
            ...result,
            items: [...contracts.values()],
            pageOffset: previous.pageOffset,
          };
        });
        setSourceInfo({
          source: result.source,
          dataMode: result.dataMode,
          observedAt: result.observedAt,
        });
        if (result.dataMode) {
          onDataMode?.(result.dataMode);
        }
        if (
          typeof result.underlyingPrice === "number" &&
          Number.isFinite(result.underlyingPrice) &&
          result.underlyingPrice > 0
        ) {
          onReferenceData?.({
            spot: result.underlyingPrice,
            day: result.sessionDay,
            expiry,
          });
        }
        if (result.items.length && result.dataMode !== "historical") {
          try {
            await read("/market/live-feed", {
              instruments: result.items.map((item) => item.instrument),
            });
          } catch (failure) {
            if (current === generation.current) {
              setFeedError((failure as Error).message);
            }
          }
        }
      } catch (failure) {
        if (current === generation.current) {
          setError((failure as Error).message);
        }
      } finally {
        if (current === generation.current) {
          appendNextPage.current = false;
          setBusy(false);
        }
      }
    })();
    return () => {
      generation.current = current + 1;
    };
  }, [
    underlying,
    expiry,
    offset,
    positionStrikes,
    read,
    experience,
    workspaceBody,
    onDataMode,
    onReferenceData,
  ]);

  const optionChain = useOptionChain(chain, ticks);
  const valuationDate =
    chain?.sessionDay ??
    asOf ??
    new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const greeks = useOptionGreeks(csrf, {
    spot: analytics ? chain?.underlyingPrice : null,
    expiry,
    valuationDate,
    contracts: analytics ? optionChain.items : [],
  });
  const maxOi = optionChain.maxOpenInterest;
  /** Append the next contract page when the user reaches the chain's lower edge. */
  const loadMoreContracts = useCallback(
    (container: HTMLDivElement) => {
      const nearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        96;
      if (
        !nearBottom ||
        busy ||
        appendNextPage.current ||
        chain?.nextOffset === null ||
        chain?.nextOffset === undefined
      ) {
        return;
      }
      appendNextPage.current = true;
      setOffset(chain.nextOffset);
    },
    [busy, chain?.nextOffset],
  );
  const side = (item: Contract | undefined, right: "call" | "put") => {
    const current = Boolean(
      item && optionChain.liveInstruments.has(item.instrument),
    );
    const oi = (
      <td className={`chain-oi ${right}`}>
        <span
          style={{ width: `${(100 * (item?.openInterest ?? 0)) / maxOi}%` }}
        />
        <b>{item?.openInterest?.toLocaleString("en-IN") ?? "—"}</b>
      </td>
    );
    const mark = (
      <td
        className={`chain-ltp ${current ? "has-tick" : ""}`}
        title={item?.symbol}
      >
        {item ? (
          compact && !analytics ? (
            <span className="chain-price-static">{amount(item.price)}</span>
          ) : (
            <button
              className="chain-price-button"
              aria-label={`Inspect ${item.symbol} ${item.option?.expiryDate} ${item.option?.strikePrice} ${right}`}
              onClick={() => {
                setSelectedToken(item.instrument);
                setDraftError("");
                detailDialog.current?.showModal();
              }}
            >
              {amount(item.price)}
            </button>
          )
        ) : (
          "—"
        )}
        {!current && sourceInfo.dataMode !== "historical" && (
          <small>
            {!item ? "—" : item.tickAt || item.stale ? "Stale" : "Snapshot"}
          </small>
        )}
      </td>
    );
    const greek = greeks.values.get(item?.instrument ?? "");
    const greekCell = (
      label: "Delta" | "Gamma" | "Theta" | "Vega" | "IV",
      value: number | null | undefined,
      digits: number,
    ) => (
      <td
        className="chain-greek"
        title={
          value === null || value === undefined
            ? `${label} unavailable for this premium`
            : `${label} derived by ${label === "IV" ? "implied-volatility inversion" : "Black-76 synthetic-forward analytics"}`
        }
      >
        {typeof value === "number" && Number.isFinite(value)
          ? value.toFixed(digits)
          : "—"}
      </td>
    );
    const gamma = greekCell("Gamma", greek?.gamma, 4);
    const vega = greekCell("Vega", greek?.vega, 2);
    const theta = greekCell("Theta", greek?.theta, 2);
    const delta = greekCell("Delta", greek?.delta, 3);
    // The essential view keeps both premiums and the strike visible; details retain actions and analytics.
    if (analytics && essentialColumns) {
      return mark;
    }
    if (analytics) {
      const actions = (
        <td className="chain-trade-actions">
          {item && (
            <>
              <button
                type="button"
                aria-label={`Review buy ${item.symbol} ${item.option?.expiryDate} ${item.option?.strikePrice} ${right}`}
                disabled={sourceInfo.dataMode === "historical" || !onTrade}
                onClick={() => onTrade?.(item, "buy")}
              >
                B
              </button>
              <button
                type="button"
                aria-label={`Review sell ${item.symbol} ${item.option?.expiryDate} ${item.option?.strikePrice} ${right}`}
                disabled={sourceInfo.dataMode === "historical" || !onTrade}
                onClick={() => onTrade?.(item, "sell")}
              >
                S
              </button>
            </>
          )}
        </td>
      );
      return right === "call" ? (
        <>
          {gamma}
          {vega}
          {theta}
          {delta}
          {oi}
          {actions}
          {mark}
          {greekCell("IV", greek?.impliedVolatility, 2)}
        </>
      ) : (
        <>
          {mark}
          {actions}
          {oi}
          {delta}
          {theta}
          {vega}
          {gamma}
        </>
      );
    }
    if (compact) {
      const selectedSides = new Set(
        activeLegs
          .filter(
            (leg) =>
              (!leg.stockCode || leg.stockCode === item?.symbol) &&
              leg.expiryDate === item?.option?.expiryDate &&
              leg.strikePrice === item?.option?.strikePrice &&
              leg.right === item?.option?.right,
          )
          .map((leg) => leg.side),
      );
      const actions = (
        <td className="chain-leg-actions">
          {item && onAddLeg ? (
            <>
              <button
                type="button"
                className={`chain-leg-button buy${selectedSides.has("buy") ? " selected" : ""}`}
                aria-pressed={selectedSides.has("buy")}
                aria-label={`Add buy ${item.symbol} ${item.option?.strikePrice} ${right} to payoff`}
                onClick={() => addContractLeg(item, "buy")}
              >
                B
              </button>
              <button
                type="button"
                className={`chain-leg-button sell${selectedSides.has("sell") ? " selected" : ""}`}
                aria-pressed={selectedSides.has("sell")}
                aria-label={`Add sell ${item.symbol} ${item.option?.strikePrice} ${right} to payoff`}
                onClick={() => addContractLeg(item, "sell")}
              >
                S
              </button>
            </>
          ) : (
            "—"
          )}
        </td>
      );
      return right === "call" ? (
        <>
          {actions}
          {mark}
        </>
      ) : (
        <>
          {mark}
          {actions}
        </>
      );
    }
    return right === "call" ? (
      <>
        {oi}
        <td>{item?.volume?.toLocaleString("en-IN") ?? "—"}</td>
        <td className={(item?.change ?? 0) < 0 ? "negative" : "positive"}>
          {amount(item?.change)}
        </td>
        <td>{amount(item?.bid)}</td>
        <td>{amount(item?.ask)}</td>
        {mark}
      </>
    ) : (
      <>
        {mark}
        <td>{amount(item?.bid)}</td>
        <td>{amount(item?.ask)}</td>
        <td className={(item?.change ?? 0) < 0 ? "negative" : "positive"}>
          {amount(item?.change)}
        </td>
        <td>{item?.volume?.toLocaleString("en-IN") ?? "—"}</td>
        {oi}
      </>
    );
  };
  const selected = optionChain.items.find(
    (item) => item.instrument === selectedToken,
  );
  const selectedTick = optionChain.tickByInstrument.get(selectedToken);
  /** Add a chain row directly to the adjacent payoff without opening a second view. */
  function addContractLeg(item: Contract, side: "buy" | "sell") {
    if (!onAddLeg) {
      return;
    }
    const message = onAddLeg(item, side);
    setDraftError(message);
  }
  /** Only copy metadata into a draft; stale prices never become executable order premiums. */
  function addSelectedLeg(side: "buy" | "sell") {
    if (!selected || !onAddLeg) {
      return;
    }
    const message = onAddLeg(selected, side);
    if (message) {
      setDraftError(message);
    } else {
      detailDialog.current?.close();
    }
  }
  /** Keep compact provenance useful without repeating the full provider description. */
  const compactSourceLabel =
    error && !chain
      ? "Unavailable"
      : sourceInfo.dataMode === "historical"
        ? `Snapshot${sourceInfo.observedAt ? ` · ${new Date(sourceInfo.observedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}`
        : sourceInfo.dataMode === "live"
          ? "Live"
          : "Loading";
  const sourceDescription = `${chain?.source || sourceInfo.source || "Market data provider"} · ${sourceInfo.observedAt ? new Date(sourceInfo.observedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "current observation"} IST`;
  /** Reuse the same controlled expiry selector in compact and full layouts. */
  const expirySelect = (
    <select
      aria-label="Option chain expiry"
      value={expiry}
      disabled={!expiries.length}
      onChange={(event) => {
        onExpiryChange?.();
        setExpiry(event.target.value);
        setOffset(-1);
      }}
    >
      {!expiries.length && (
        <option value="">
          {busy ? "Loading expiries…" : "No expiries available"}
        </option>
      )}
      {expiries.map((day) => (
        <option key={day}>{day}</option>
      ))}
    </select>
  );
  return (
    <section
      className={`live-option-chain${compact ? " reference-chain" : ""}${analytics ? " analytics-chain" : ""}`}
      aria-label={
        sourceInfo.dataMode === "historical"
          ? "Historical option chain"
          : "Live option chain"
      }
    >
      <dialog
        ref={detailDialog}
        className={`workspace-dialog contract-drawer${showChart ? " contract-drawer-chart" : ""}`}
        aria-labelledby="contract-detail-title"
        onClose={() => {
          setSelectedToken("");
          setShowChart(false);
        }}
      >
        <div className="screen-toolbar">
          <h2 id="contract-detail-title">Strike detail</h2>
          <Button
            variant="secondary"
            onClick={() => detailDialog.current?.close()}
          >
            Close details
          </Button>
        </div>
        {selected ? (
          <>
            <p>
              {selected.symbol} · {selected.option?.expiryDate} ·{" "}
              {selected.option?.strikePrice} {selected.option?.right}
            </p>
            <p>
              Lot size:{" "}
              {selected.lotSize > 0
                ? `${selected.lotSize} units`
                : "unavailable in legacy archive"}{" "}
              · LTP ₹{amount(selected.price)} ·{" "}
              {selectedTick?.receivedRecently
                ? "Recent quote"
                : "Snapshot / stale"}
            </p>
            <Button
              variant="secondary"
              onClick={() => setShowChart((value) => !value)}
            >
              {showChart ? "Hide price chart" : "Open price chart"}
            </Button>
            {showChart && (
              <ContractPriceChart
                key={selected.instrument}
                instrument={selected}
              />
            )}
            <table>
              <thead>
                <tr>
                  <th>Bid qty</th>
                  <th>Bid</th>
                  <th>Ask</th>
                  <th>Ask qty</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(
                  {
                    length: Math.max(
                      1,
                      Math.min(
                        5,
                        Math.max(
                          selectedTick?.depth?.buy.length ?? 0,
                          selectedTick?.depth?.sell.length ?? 0,
                        ),
                      ),
                    ),
                  },
                  (_, index) => (
                    <tr key={index}>
                      <td>
                        {selectedTick?.depth?.buy[index]?.quantity ?? "—"}
                      </td>
                      <td>
                        {amount(
                          selectedTick?.depth?.buy[index]?.price ??
                            (index === 0 ? selected.bid : null),
                        )}
                      </td>
                      <td>
                        {amount(
                          selectedTick?.depth?.sell[index]?.price ??
                            (index === 0 ? selected.ask : null),
                        )}
                      </td>
                      <td>
                        {selectedTick?.depth?.sell[index]?.quantity ?? "—"}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
            <p>
              {analytics
                ? "Only available broker depth is shown. IV and Greeks are derived from the displayed premium by the calculation service."
                : "Only available broker depth is shown."}
            </p>
            {draftError && <p role="alert">{draftError}</p>}
            {onAddLeg && (
              <div className="screen-toolbar">
                <Button onClick={() => addSelectedLeg("buy")}>
                  Add Buy leg
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => addSelectedLeg("sell")}
                >
                  Add Sell leg
                </Button>
              </div>
            )}
            <p>Adding a leg opens research. It does not place an order.</p>
            {onTrade && sourceInfo.dataMode === "live" && (
              <div className="screen-toolbar">
                <Button
                  onClick={() => {
                    detailDialog.current?.close();
                    onTrade(selected, "buy");
                  }}
                >
                  Review buy order
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    detailDialog.current?.close();
                    onTrade(selected, "sell");
                  }}
                >
                  Review sell order
                </Button>
              </div>
            )}
          </>
        ) : (
          <p>This contract is no longer in the current chain selection.</p>
        )}
      </dialog>
      <header className={compact ? "chain-compact-header" : undefined}>
        <div>
          <h3>{compact ? underlying : "Option chain"}</h3>
          {compact ? (
            <p className="chain-compact-summary">
              {chain?.underlyingPrice
                ? `₹${amount(chain.underlyingPrice)}`
                : "Price unavailable"}
            </p>
          ) : (
            <>
              <p>
                {chain?.source || sourceInfo.source || "Market data provider"} ·
                NSE options ·{" "}
                {onTrade ? "Review orders before submission" : "read only"}
              </p>
              {chain?.underlyingPrice && (
                <p>Underlying close ₹{amount(chain.underlyingPrice)}</p>
              )}
            </>
          )}
        </div>
        {compact ? (
          <>
            <label className="chain-expiry-inline">
              <span>Expiry</span>
              {expirySelect}
            </label>
            <span className="chain-data-badge" title={sourceDescription}>
              {compactSourceLabel}
            </span>
          </>
        ) : (
          <span className="chain-source">
            {sourceInfo.dataMode === "historical"
              ? `${experience === "chain" ? "Last available close" : "Stored snapshot"}${sourceInfo.observedAt ? ` · ${new Date(sourceInfo.observedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : ""}`
              : sourceInfo.dataMode === "live"
                ? "Active broker live feed"
                : error
                  ? "Data unavailable"
                  : "Checking data source…"}
          </span>
        )}
      </header>
      {(!compact || !selectedUnderlying) && (
        <div className="chain-toolbar">
          {!selectedUnderlying && (
            <>
              <label>
                {compact ? "Underlying" : "Select index"}
                <select
                  aria-label="Option chain index"
                  value={index}
                  onChange={(e) => {
                    setExpiry("");
                    setMembers(null);
                    setMemberError("");
                    setIndex(e.target.value);
                    setUnderlying(e.target.value);
                  }}
                >
                  {[
                    "NIFTY",
                    "NIFTYNXT50",
                    "FINNIFTY",
                    "BANKNIFTY",
                    "MIDCPNIFTY",
                    "NIFTYFPI",
                  ].map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                Constituent stock
                <select
                  aria-label="Option chain underlying"
                  value={underlying === index ? "" : underlying}
                  disabled={!eligibleStocks.length}
                  onChange={(e) => {
                    setExpiry("");
                    setUnderlying(e.target.value || index);
                  }}
                >
                  <option value="">
                    {memberError
                      ? "Constituents unavailable"
                      : !members
                        ? "Loading constituents…"
                        : !symbols.length
                          ? "Loading provider symbols…"
                          : !eligibleStocks.length
                            ? "No constituents with listed options"
                            : `Select stock — ${index} chain`}
                  </option>
                  {eligibleStocks.map((symbol) => (
                    <option key={symbol}>{symbol}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            Expiry
            {expirySelect}
          </label>
        </div>
      )}
      {memberError && <p role="alert">{memberError}</p>}
      {searchError && <p role="alert">Search: {searchError}</p>}
      {error && <p role="alert">{error}</p>}
      {feedError && <p role="alert">Feed: {feedError}</p>}
      {draftError && <p role="alert">{draftError}</p>}
      {analytics && greeks.error && <p role="alert">Greeks: {greeks.error}</p>}
      {chain?.warning &&
        (chain.dataMode === "historical" ||
          !optionChain.items.some((item) => item.tickAt)) && (
          <p role="status">{chain.warning}</p>
        )}
      {busy && !chain && <p role="status">Loading selected option chain…</p>}
      <div
        className="table-wrap chain-scroll"
        onScroll={(event) => loadMoreContracts(event.currentTarget)}
      >
        <table className={essentialColumns ? "chain-essentials" : undefined}>
          <thead>
            <tr>
              <th
                colSpan={
                  analytics ? (essentialColumns ? 1 : 8) : compact ? 2 : 6
                }
                className="chain-call-heading"
              >
                CALLS
              </th>
              <th rowSpan={2} className="chain-strike">
                Strike
              </th>
              {analytics && !essentialColumns && <th rowSpan={2}>PCR</th>}
              <th
                colSpan={
                  analytics ? (essentialColumns ? 1 : 7) : compact ? 2 : 6
                }
                className="chain-put-heading"
              >
                PUTS
              </th>
            </tr>
            <tr>
              {analytics && essentialColumns ? (
                <>
                  <th>Call premium ₹</th>
                  <th>Put premium ₹</th>
                </>
              ) : analytics ? (
                <>
                  {[
                    "Gamma",
                    "Vega",
                    "Theta",
                    "Delta",
                    "OI",
                    "Order",
                    "Call LTP",
                    "IV",
                    "Put LTP",
                    "Order",
                    "OI",
                    "Delta",
                    "Theta",
                    "Vega",
                    "Gamma",
                  ].map((label, index) => (
                    <th key={`${label}-${index}`}>{label}</th>
                  ))}
                </>
              ) : compact ? (
                <>
                  <th>B / S</th>
                  <th>Call LTP</th>
                  <th>Put LTP</th>
                  <th>B / S</th>
                </>
              ) : (
                <>
                  <th>OI</th>
                  <th>Volume</th>
                  <th>Change ₹</th>
                  <th>Bid ₹</th>
                  <th>Ask ₹</th>
                  <th>LTP ₹</th>
                  <th>LTP ₹</th>
                  <th>Bid ₹</th>
                  <th>Ask ₹</th>
                  <th>Change ₹</th>
                  <th>Volume</th>
                  <th>OI</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {[...optionChain.pairs]
              .sort(([a], [b]) => a - b)
              .map(([strike, pair]) => (
                <tr key={strike}>
                  {side(pair.call, "call")}
                  <th className="chain-strike">
                    {strike.toLocaleString("en-IN")}
                  </th>
                  {analytics && !essentialColumns && (
                    <td>
                      {pair.call?.openInterest !== null &&
                      pair.call?.openInterest !== undefined &&
                      pair.call.openInterest !== 0 &&
                      pair.put?.openInterest !== null &&
                      pair.put?.openInterest !== undefined
                        ? amount(pair.put.openInterest / pair.call.openInterest)
                        : "—"}
                    </td>
                  )}
                  {side(pair.put, "put")}
                </tr>
              ))}
          </tbody>
        </table>
        {busy && chain && (
          <p className="chain-load-more" role="status">
            Loading more strikes…
          </p>
        )}
      </div>
      {chain && !optionChain.items.length && (
        <p>No contracts for this selection.</p>
      )}
      <p className="chain-note">
        {error && !chain
          ? "No option prices loaded. Cash history cannot substitute for option premiums."
          : sourceInfo.dataMode === "historical"
            ? analytics
              ? "Stored premiums are replay observations, not executable quotes. Greeks are derived from observed premiums; missing values are never filled."
              : "Stored premiums are replay observations, not executable quotes. Missing strikes and dates are never filled or estimated."
            : analytics
              ? "Prices and OI update from the shared tick batch. Greeks are derived from displayed premiums by the calculation service."
              : "Prices and OI update from the same tick batch as dashboard P&L. This page streams up to 50 chain contracts alongside up to 50 open positions."}
      </p>
    </section>
  );
}
