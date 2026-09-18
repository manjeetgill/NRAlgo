"use client";

/** Broker-fed paper UI. Only authenticated /paper endpoints are used; no broker SDK, real
 * order endpoint or credential storage exists in the browser. Each selected broker remounts
 * its wallet view so an old response cannot overwrite the newly selected broker's state.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { requestApiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { BrokerPortfolioPanel } from "./broker-portfolio-panel";
import { KotakOptionChain } from "./kotak-option-chain";
import {
  PaperInstrumentPicker,
  KotakCashSymbolSelect,
  type PaperInstrument,
} from "./paper-instrument-picker";
type Broker = "kotak";
type Order = {
  key: string;
  instrument: string;
  side: string;
  quantity: number;
  limitPaise: number;
  state: string;
  fillPaise?: number;
  option?: {
    expiryDate: string;
    right: string;
    strikePrice: number;
    lotSize: number;
  };
};
type Quote = {
  instrument: string;
  bid: number;
  ask: number;
  observedAt: number;
  receivedAt: number;
};
type Wallet = {
  connected: boolean;
  cashPaise: number;
  reservedPaise: number;
  realizedPaise: number;
  unrealizedPaise: number | null;
  equityPaise: number | null;
  orders: Order[];
  positions: Record<string, { quantity: number; costPaise: number }>;
  marks: Record<string, Quote>;
  stale?: boolean;
  settlementRequired?: string[];
};
const money = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "Unavailable / stale"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
      }).format(value / 100);
/** Same-origin, CSRF-protected requests. Server errors contain no broker tokens. */
function request(path: string, csrf: string, body?: unknown, method?: string) {
  return requestApiJson(
    `/paper/${path}`,
    method || (body === undefined ? "GET" : "POST"),
    body,
    csrf,
    95000,
  );
}
export function PaperTradingPanel({ csrf }: { csrf: string }) {
  const broker: Broker = "kotak";
  const [portfolio, setPortfolio] = useState(false);
  return (
    <section className="research-panel" aria-label="Broker paper trading">
      <h2>Broker-connected paper trading</h2>
      <p>Real broker quotes · Virtual ₹1,00,000 per broker · No real orders</p>
      <p>Market-data broker: Kotak Neo</p>
      <Button variant="secondary" onClick={() => setPortfolio(!portfolio)}>
        {portfolio ? "Back to paper trading" : "View broker portfolio"}
      </Button>
      {portfolio ? (
        <BrokerPortfolioPanel key={broker} broker={broker} csrf={csrf} />
      ) : (
        <PaperWallet key={broker} broker={broker} csrf={csrf} />
      )}
    </section>
  );
}
/** One wallet mounts at a time. Polling stops on navigation, hidden tab, failure or explicit stop. */
function PaperWallet({ broker, csrf }: { broker: Broker; csrf: string }) {
  const [wallet, setWallet] = useState<Wallet | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [automatic, setAutomatic] = useState(false);
  const running = useRef(false),
    orderKey = useRef("");
  const [instrument, setInstrument] = useState(""),
    [side, setSide] = useState("buy");
  const [quantity, setQuantity] = useState(1),
    [limit, setLimit] = useState("100");
  const [market, setMarket] = useState("cash");
  const [option, setOption] = useState({
    expiryDate: "",
    right: "call",
    strikePrice: 0,
    lotSize: 1,
  });
  const [selectedInstrument, setSelectedInstrument] =
    useState<PaperInstrument | null>(null);
  const contractFields = useMemo(
    () => ({
      ...(market === "options" ? { option } : {}),
      ...(selectedInstrument
        ? { masterToken: selectedInstrument.masterToken }
        : {}),
    }),
    [market, option, selectedInstrument],
  );
  const [editing, setEditing] = useState<Order | null>(null),
    [editQuantity, setEditQuantity] = useState(1),
    [editLimit, setEditLimit] = useState("");
  const [login, setLogin] = useState({
    accessToken: "",
    mobileNumber: "",
    ucc: "",
    totp: "",
    mpin: "",
  });
  const [, tick] = useState(0);
  useEffect(() => {
    let active = true;
    request(broker, csrf)
      .then((data) => {
        if (active) {
          setWallet(data);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
        }
      });
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [broker, csrf]);
  /** Serialize UI actions; preserve the idempotency key after an uncertain response for safe retry. */
  const act = useCallback(async (operation: () => Promise<void>) => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      setAutomatic(false);
      setError(e instanceof Error ? e.message : "Paper action failed.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  /** Each tick requests server-side market data, never submits client-supplied prices for fills. */
  const refresh = useCallback(
    async (includeDraft = false) => {
      const result = await request(
        `${broker}/refresh`,
        csrf,
        includeDraft ? { instrument, ...contractFields } : {},
      );
      setWallet((previous) => ({ ...previous, ...result, connected: true }));
      setNotice(
        result.stale
          ? "Stale or empty quotes: affected orders remain unfilled."
          : "Quote cycle completed. Eligible paper limits were matched locally.",
      );
    },
    [broker, contractFields, csrf, instrument],
  );
  useEffect(() => {
    if (!automatic) {
      return;
    }
    const timer = setInterval(() => {
      if (!document.hidden) {
        void act(() => refresh());
      }
    }, 10000);
    const hide = () => {
      if (document.hidden) {
        setAutomatic(false);
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [act, automatic, refresh]);
  /** Retrying identical content reuses the same key. Editing fields explicitly starts a new intent. */
  function submit(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      orderKey.current ||= crypto.randomUUID();
      const result = await request(`${broker}/orders`, csrf, {
        key: orderKey.current,
        instrument,
        ...contractFields,
        side,
        quantity,
        limitPaise: Math.round(Number(limit) * 100),
      });
      setWallet((previous) => ({ ...previous, ...result }));
      orderKey.current = "";
      setNotice(
        "Paper order accepted locally. Refresh quotes to evaluate a fill.",
      );
    });
  }
  const held = Object.entries(wallet?.positions || {}).filter(
    ([, position]) => position.quantity > 0,
  );
  const staleMarks = held.some(([symbol]) => {
    const mark = wallet?.marks[symbol];
    return (
      !mark ||
      Date.now() - mark.receivedAt > 15000 ||
      Date.now() - mark.observedAt > 60000
    );
  });
  return (
    <div className="paper-wallet">
      <p role="status">
        {wallet?.connected
          ? "Data connection available"
          : "Data broker not connected"}{" "}
        ·{" "}
        {automatic
          ? "Quote matching every 10 seconds"
          : "Automatic matching stopped"}
      </p>
      {
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              try {
                await request("kotak/connect", csrf, login);
                setWallet(await request(broker, csrf));
                setNotice("Kotak connected for market data only.");
              } finally {
                setLogin({
                  accessToken: "",
                  mobileNumber: "",
                  ucc: "",
                  totp: "",
                  mpin: "",
                });
              }
            });
          }}
          autoComplete="off"
        >
          <h3>Kotak data connection</h3>
          <p>
            API dashboard token, registered TOTP and MPIN. Used only by your
            server; not saved. Reconnect after logout or server restart.
          </p>
          <div className="paper-grid">
            {(
              [
                ["accessToken", "Kotak API access token", "password"],
                ["mobileNumber", "Mobile (+91…)", "text"],
                ["ucc", "Kotak client code (UCC)", "text"],
                ["totp", "Kotak TOTP", "password"],
                ["mpin", "Kotak MPIN", "password"],
              ] as const
            ).map(([key, label, type]) => (
              <label key={key}>
                {label}
                <input
                  required
                  type={type}
                  value={login[key]}
                  onChange={(e) =>
                    setLogin({ ...login, [key]: e.target.value })
                  }
                  autoComplete="off"
                />
              </label>
            ))}
          </div>
          <Button disabled={busy} type="submit">
            Connect Kotak data
          </Button>
          {wallet?.connected && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setAutomatic(false);
                  await request("kotak/connect", csrf, undefined, "DELETE");
                  setWallet(await request(broker, csrf));
                })
              }
            >
              Disconnect Kotak
            </Button>
          )}
        </form>
      }
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <h3>Paper portfolio · virtual funds only</h3>
      {!!wallet?.settlementRequired?.length && (
        <p role="alert">
          Expired contracts need settlement, which is not simulated. Their value
          is unavailable; no automatic cash settlement is applied.
        </p>
      )}
      <div className="paper-grid">
        <div>
          Virtual cash<strong>{money(wallet?.cashPaise)}</strong>
        </div>
        <div>
          Reserved cash<strong>{money(wallet?.reservedPaise)}</strong>
        </div>
        <div>
          Realized P&amp;L<strong>{money(wallet?.realizedPaise)}</strong>
        </div>
        <div>
          Unrealized P&amp;L
          <strong>{money(staleMarks ? null : wallet?.unrealizedPaise)}</strong>
        </div>
      </div>
      <form
        onSubmit={submit}
        onChange={() => {
          orderKey.current = "";
        }}
      >
        <h3>NSE cash / options · Paper limit order</h3>
        <label>
          Paper market
          <select
            value={market}
            onChange={(e) => {
              setMarket(e.target.value);
              setSelectedInstrument(null);
            }}
          >
            <option value="cash">NSE cash</option>
            <option value="options">NSE options (NFO)</option>
          </select>
        </label>
        {broker === "kotak" && market === "options" && (
          <KotakOptionChain
            csrf={csrf}
            disabled={busy || !wallet?.connected}
            onSelect={(item) => {
              setSelectedInstrument(item);
              setInstrument(item.instrument);
              if (item.option) {
                setOption(item.option);
              }
              setQuantity(item.lotSize);
              orderKey.current = "";
              setNotice(
                "Kotak contract selected. Review the paper limit; a fresh quote is required for matching.",
              );
            }}
          />
        )}
        {!(broker === "kotak" && market === "cash") && (
          <PaperInstrumentPicker
            key={`${broker}:${market}`}
            broker={broker}
            market={market as "cash" | "options"}
            csrf={csrf}
            disabled={busy || !wallet?.connected}
            onSelect={(item) => {
              setSelectedInstrument(item);
              setInstrument(item.instrument);
              if (item.option) {
                setOption(item.option);
              }
              setQuantity(item.lotSize);
              orderKey.current = "";
              setNotice(
                "Contract selected from broker master. Quantity set to one lot; review side and limit before placing a paper order.",
              );
            }}
          />
        )}
        {selectedInstrument ? (
          <p>
            Broker-master contract selected; identity and lot size are locked.{" "}
            {!(broker === "kotak" && market === "cash") && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setSelectedInstrument(null);
                  orderKey.current = "";
                }}
              >
                Use manual research entry
              </Button>
            )}
          </p>
        ) : (
          <p>
            {broker === "kotak" && market === "cash"
              ? "Select a supported symbol from the Kotak dropdown below. Its broker token is filled automatically."
              : "Manual research entry: contract details and lot sizes are unverified. Prefer selecting a broker-master contract above."}
          </p>
        )}
        {market === "options" && (
          <div className="paper-grid">
            <label>
              Option expiry
              <input
                required
                type="date"
                disabled={Boolean(selectedInstrument)}
                value={option.expiryDate}
                onChange={(e) =>
                  setOption({ ...option, expiryDate: e.target.value })
                }
              />
            </label>
            <label>
              Option type
              <select
                value={option.right}
                disabled={Boolean(selectedInstrument)}
                onChange={(e) =>
                  setOption({ ...option, right: e.target.value })
                }
              >
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </label>
            <label>
              Strike (₹)
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={option.strikePrice || ""}
                disabled={Boolean(selectedInstrument)}
                onChange={(e) =>
                  setOption({ ...option, strikePrice: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Declared lot size
              <input
                required
                type="number"
                min="1"
                max="10000"
                value={option.lotSize}
                disabled={Boolean(selectedInstrument)}
                onChange={(e) =>
                  setOption({ ...option, lotSize: Number(e.target.value) })
                }
              />
            </label>
          </div>
        )}
        <div className="paper-grid">
          {broker === "kotak" && market === "cash" ? (
            <KotakCashSymbolSelect
              csrf={csrf}
              connected={Boolean(wallet?.connected)}
              disabled={busy}
              selected={selectedInstrument}
              onSelect={(item) => {
                setSelectedInstrument(item);
                setInstrument(item.instrument);
                setQuantity(item.lotSize);
                orderKey.current = "";
                setNotice(
                  "Kotak symbol selected. Review quantity and limit, then refresh paper quotes.",
                );
              }}
              onClear={() => {
                setSelectedInstrument(null);
                setInstrument("");
                orderKey.current = "";
              }}
            />
          ) : (
            <label>
              Kotak NFO option token (pSymbol)
              <input
                required
                value={instrument}
                disabled={Boolean(selectedInstrument)}
                onChange={(e) => setInstrument(e.target.value.toUpperCase())}
              />
            </label>
          )}
          <label>
            Paper side
            <select value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="buy">Buy</option>
              <option value="sell">Sell held units</option>
            </select>
          </label>
          <label>
            Paper quantity
            <input
              required
              type="number"
              min="1"
              max="10000"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>
          <label>
            Paper limit (₹)
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </div>
        <Button
          disabled={
            busy ||
            !wallet?.connected ||
            (broker === "kotak" && market === "cash" && !selectedInstrument)
          }
        >
          Place paper order
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !wallet?.connected || !instrument}
          onClick={() => void act(() => refresh(true))}
        >
          Refresh paper quotes
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!wallet?.connected}
          onClick={() => setAutomatic((value) => !value)}
        >
          {automatic ? "Stop paper matching" : "Start paper matching"}
        </Button>
      </form>
      <p>
        Weekdays 09:15–15:30 IST; DAY orders expire. Up to four active
        instruments. Matching runs only while this page is active. A
        stopped/hidden page does not cancel orders; they can match on your next
        refresh.
      </p>
      <p>
        Illustrative full fills at bid/ask + 5 bps slippage, within your limit;
        ₹5 per fill. No partial fills, queue modeling, taxes or exchange tick
        validation. Options support buying calls/puts and selling held units
        only, not naked selling or margin. Quantity is units and must be a
        multiple of your declared lot size. Verify contract details and lot size
        against the broker instrument master. Picker-selected metadata and lots
        are checked server-side; manual entries are unverified research labels.
        Search again when the 15-minute master cache expires. Expiry settlement
        is not simulated.
      </p>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const result = await request(
                `${broker}/orders/${editing.key}/modify`,
                csrf,
                {
                  quantity: editQuantity,
                  limitPaise: Math.round(Number(editLimit) * 100),
                },
              );
              setWallet((previous) => ({ ...previous, ...result }));
              setEditing(null);
            });
          }}
        >
          <h3>Modify paper order · {editing.instrument}</h3>
          <label>
            Modified quantity
            <input
              type="number"
              min="1"
              required
              value={editQuantity}
              onChange={(e) => setEditQuantity(Number(e.target.value))}
            />
          </label>
          <label>
            Modified limit (₹)
            <input
              type="number"
              step="0.01"
              min="0.01"
              required
              value={editLimit}
              onChange={(e) => setEditLimit(e.target.value)}
            />
          </label>
          <Button disabled={busy}>Save paper modification</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setEditing(null)}
          >
            Close modification
          </Button>
        </form>
      )}
      <h3>Paper positions</h3>
      <div className="paper-table">
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Units</th>
              <th>Cost including entry fees</th>
              <th>Latest bid</th>
            </tr>
          </thead>
          <tbody>
            {held.map(([symbol, position]) => (
              <tr key={symbol}>
                <td>{symbol}</td>
                <td>{position.quantity}</td>
                <td>{money(position.costPaise)}</td>
                <td>
                  {wallet?.marks[symbol] &&
                  Date.now() - wallet.marks[symbol].receivedAt <= 15000 &&
                  Date.now() - wallet.marks[symbol].observedAt <= 60000
                    ? money(wallet.marks[symbol].bid)
                    : "Stale / unavailable"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Paper orders</h3>
      <div className="paper-table">
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Side</th>
              <th>Units</th>
              <th>Limit</th>
              <th>Status</th>
              <th>Fill</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {[...(wallet?.orders || [])].reverse().map((order) => (
              <tr key={order.key}>
                <td>
                  {order.instrument}
                  {order.option &&
                    ` ${order.option.expiryDate} ${order.option.strikePrice} ${order.option.right}`}
                </td>
                <td>{order.side}</td>
                <td>{order.quantity}</td>
                <td>{money(order.limitPaise)}</td>
                <td>{order.state}</td>
                <td>{order.fillPaise ? money(order.fillPaise) : "—"}</td>
                <td>
                  {order.state === "open" && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setEditing(order);
                          setEditQuantity(order.quantity);
                          setEditLimit(String(order.limitPaise / 100));
                        }}
                      >
                        Modify
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const result = await request(
                              `${broker}/orders/${order.key}/cancel`,
                              csrf,
                              {},
                            );
                            setWallet((previous) => ({
                              ...previous,
                              ...result,
                            }));
                          })
                        }
                      >
                        Cancel paper order
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
