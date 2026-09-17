"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Blocks,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Database,
  FlaskConical,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Pause,
  Play,
  Plus,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Strategy = {
  id: string;
  name: string;
  symbol: string;
  fast: number;
  slow: number;
  capital: number;
  status: string;
  pnl: number;
};
type Fill = {
  bar: number;
  side: string;
  price: number;
  quantity: number;
  pnl: number | null;
};
type Result = {
  pnl?: number;
  drawdown?: number;
  equity?: number[];
  trades?: Fill[];
  cost_model?: string;
};
type Job = {
  id: string;
  strategy_id: string;
  status: string;
  created_at: string;
  result: Result;
};
type Workspace = {
  username: string;
  csrf: string;
  halted: boolean;
  strategies: Strategy[];
  jobs: Job[];
  events: { id: number; message: string; created_at: string }[];
};
type Page =
  | "Overview"
  | "Strategies"
  | "Orders & trades"
  | "Brokers"
  | "Activity log"
  | "Learn the stack";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);

async function api(
  path: string,
  method = "GET",
  data?: unknown,
  csrf?: string,
) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response
    .json()
    .catch(() => ({
      detail: "API unavailable. Check that the Node.js server is running.",
    }));
  if (!response.ok) {
    const message = Array.isArray(result.detail)
      ? result.detail.map((x: { msg: string }) => x.msg).join(". ")
      : result.detail;
    throw Object.assign(new Error(message || "Request failed"), {
      status: response.status,
    });
  }
  return result;
}

function Chart({ values }: { values: number[] }) {
  const low = Math.min(0, ...values),
    high = Math.max(1, ...values),
    span = high - low || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i / Math.max(1, values.length - 1)) * 720},${175 - ((v - low) / span) * 145}`,
    )
    .join(" ");
  return (
    <div className="chart">
      <div className="chart-labels">
        <span>{money(high)}</span>
        <span>{money((high + low) / 2)}</span>
        <span>{money(low)}</span>
      </div>
      <svg
        viewBox="0 0 720 200"
        role="img"
        aria-label="Profit and loss over the most recent synthetic replay"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#30b18a" stopOpacity=".2" />
            <stop offset="100%" stopColor="#30b18a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[30, 103, 175].map((y) => (
          <line
            key={y}
            x1="0"
            y1={y}
            x2="720"
            y2={y}
            stroke="#e9edf3"
            strokeDasharray="4 5"
          />
        ))}
        {values.length > 0 && (
          <>
            <polygon points={`0,200 ${points} 720,200`} fill="url(#area)" />
            <polyline
              points={points}
              fill="none"
              stroke="#27a580"
              strokeWidth="2.5"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      <div className="chart-times">
        <span>Bar 1</span>
        <span>60</span>
        <span>120</span>
        <span>180</span>
        <span>240</span>
      </div>
      {!values.length && (
        <div className="chart-empty">
          <TrendingUp size={26} />
          <strong>Your first results start here</strong>
          <span>Create a strategy and run a paper replay.</span>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [auth, setAuth] = useState<{
    setup_required: boolean;
    setup_token_required: boolean;
  } | null>(null);
  const [page, setPage] = useState<Page>("Overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(false);
  const [search, setSearch] = useState("");
  const [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const load = useCallback(async () => {
    try {
      setWorkspace(await api("/workspace"));
      setError("");
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        setWorkspace(null);
        setAuth(await api("/auth/status"));
      } else {
        setError((e as Error).message);
      }
    }
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (!workspace) return;
    const timer = setInterval(
      () => void load().catch((e) => setError(e.message)),
      3000,
    );
    return () => clearInterval(timer);
  }, [!!workspace, load]);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function mutate(path: string, data: unknown, message: string) {
    if (!workspace) return;
    setBusy(true);
    setError("");
    try {
      await api(path, "POST", data, workspace.csrf);
      await load();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(
        auth?.setup_required ? "/auth/setup" : "/auth/login",
        "POST",
        data,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveStrategy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(
        "/strategies",
        "POST",
        {
          ...data,
          capital: Number(data.capital),
          fast: Number(data.fast),
          slow: Number(data.slow),
          mode: "paper",
        },
        workspace?.csrf,
      );
      await load();
      setModal(false);
      setNotice("Strategy saved. Ready for a sample-data replay.");
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!workspace)
    return (
      <main className="auth-shell">
        <div className="auth-story">
          <a className="brand">
            <span className="brand-symbol">
              <Activity size={24} />
            </span>
            Nexus<span className="brand-dot">.</span>
          </a>
          <div>
            <span className="eyebrow">YOUR EDGE. YOUR WORKSPACE.</span>
            <h1>
              Build with intent.
              <br />
              Trade with clarity.
            </h1>
            <p>
              A home for your trading ideas—from the first line of JavaScript to
              your next paper strategy.
            </p>
            <div className="auth-pills">
              <span>
                <Code2 size={15} /> JavaScript powered
              </span>
              <span>
                <FlaskConical size={15} /> Paper first
              </span>
            </div>
          </div>
          <small>PERSONAL WORKSPACE · LOCALHOST EDITION</small>
        </div>
        <div className="auth-panel">
          <div className="auth-card">
            <span className="icon-tile">
              <LockKeyhole size={22} />
            </span>
            <h2>
              {auth?.setup_required
                ? "Make it your workspace."
                : "Welcome back."}
            </h2>
            <p>
              {auth?.setup_required
                ? "Create your owner account to start building. Your data stays in this local workspace."
                : "Sign in to your personal trading workspace."}
            </p>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {auth ? (
              <form onSubmit={signIn}>
                <label>
                  Username
                  <input
                    name="username"
                    autoComplete="username"
                    required
                    minLength={3}
                    maxLength={80}
                    pattern="[a-zA-Z0-9_.@-]+"
                    placeholder="Your username"
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete={
                      auth.setup_required ? "new-password" : "current-password"
                    }
                    minLength={12}
                    maxLength={128}
                    required
                    placeholder="At least 12 characters"
                  />
                </label>
                {auth.setup_required && auth.setup_token_required && (
                  <label>
                    Setup token
                    <input name="setup_token" type="password" required />
                  </label>
                )}
                <Button disabled={busy} className="w-full">
                  {busy
                    ? "Please wait…"
                    : auth.setup_required
                      ? "Create workspace"
                      : "Sign in"}
                  <ArrowRight size={16} />
                </Button>
              </form>
            ) : (
              <Button
                onClick={() => void load().catch((e) => setError(e.message))}
                variant="secondary"
              >
                {error ? "Retry connection" : "Connecting to Node.js…"}
              </Button>
            )}
            <div className="auth-note">
              <ShieldCheck size={16} />
              <span>Single-owner MVP · Live trading is disabled</span>
            </div>
          </div>
        </div>
      </main>
    );

  const latest = workspace.jobs.find((j) => j.status === "completed");
  const trades = workspace.jobs.flatMap((j) =>
    (j.result.trades || []).map((t, index) => ({
      ...t,
      id: `${j.id}-${index}`,
      strategy:
        workspace.strategies.find((s) => s.id === j.strategy_id)?.name ||
        "Strategy",
      date: j.created_at,
    })),
  );
  const pnl = workspace.strategies.reduce((sum, s) => sum + s.pnl, 0);
  const navigation = [
    { name: "Overview" as Page, icon: LayoutDashboard },
    { name: "Strategies" as Page, icon: Blocks },
    { name: "Orders & trades" as Page, icon: ArrowDownLeft },
    { name: "Brokers" as Page, icon: Wallet },
    { name: "Activity log" as Page, icon: Clock3 },
  ];
  const filtered = workspace.strategies.filter((s) =>
    `${s.name} ${s.symbol}`.toLowerCase().includes(search.toLowerCase()),
  );
  const strategyTable = (
    <>
      {!workspace.strategies.length ? (
        <div className="empty">
          <Blocks size={30} />
          <h3>A good strategy starts with an idea.</h3>
          <p>
            Create an EMA crossover strategy, then test it against a sample
            price series.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setFormError("");
              setModal(true);
            }}
          >
            <Plus size={15} /> Create your first strategy
          </Button>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>STRATEGY</th>
                <th>ENVIRONMENT</th>
                <th>STATUS</th>
                <th>LAST REPLAY P&L</th>
                <th>CAPITAL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="strategy-title">
                      <span className="strategy-tile">
                        <TrendingUp size={18} />
                      </span>
                      <div>
                        <strong>{s.name}</strong>
                        <small>
                          {s.symbol} · EMA {s.fast}/{s.slow}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="badge purple">PAPER</span>
                  </td>
                  <td>
                    <span className={`status ${s.status}`}>
                      <i />
                      {s.status}
                    </span>
                  </td>
                  <td
                    className={
                      s.pnl >= 0 ? "positive numeric" : "negative numeric"
                    }
                  >
                    {money(s.pnl)}
                  </td>
                  <td className="numeric">{money(s.capital)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      disabled={
                        busy ||
                        workspace.halted ||
                        ["queued", "running"].includes(s.status)
                      }
                      onClick={() =>
                        void mutate(
                          `/strategies/${s.id}/run`,
                          {},
                          "Replay queued for the Node.js worker.",
                        )
                      }
                    >
                      <Play size={14} /> Run replay
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <p className="empty">No matching strategies.</p>}
        </div>
      )}
    </>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={() => setPage("Overview")}>
          <span className="brand-symbol">
            <Activity size={23} />
          </span>
          Nexus<span className="brand-dot">.</span>
        </a>
        <div className="workspace-selector">
          <span className="workspace-icon">M</span>
          <div>
            <strong>My workspace</strong>
            <small>Personal · Local</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {navigation.map(({ name, icon: Icon }) => (
            <button
              key={name}
              aria-label={name}
              title={name}
              className={page === name ? "active" : ""}
              onClick={() => setPage(name)}
            >
              <Icon size={18} />
              <span>{name}</span>
              {name === "Strategies" && <b>{workspace.strategies.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="build-card">
            <span className="tiny-label">BUILT TO LEARN</span>
            <strong>Your ideas, in JavaScript.</strong>
            <p>Explore the tools behind your workspace.</p>
            <button onClick={() => setPage("Learn the stack")}>
              Explore the stack <ArrowUpRight size={14} />
            </button>
          </div>
          <button
            className="learn-link"
            aria-label="Learning guide"
            title="Learning guide"
            onClick={() => setPage("Learn the stack")}
          >
            <CircleHelp size={17} />
            <span>Learning guide</span>
          </button>
          <div className="profile">
            <span className="avatar">
              {workspace.username[0].toUpperCase()}
            </span>
            <div>
              <strong>{workspace.username}</strong>
              <small>Workspace owner</small>
            </div>
            <button
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await api("/auth/logout", "POST", {}, workspace.csrf);
                  setWorkspace(null);
                  setAuth(await api("/auth/status"));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <i /> Localhost
            </span>
            <span className="topbar-divider" />
            <ShieldCheck size={16} />
            <span>Owner access</span>
          </div>
        </header>
        <main className="content">
          <div className="heading">
            <div>
              <p className="eyebrow">YOUR TRADING COMMAND CENTER</p>
              <h1>
                {page === "Overview" ? "A clearer view of your edge." : page}
              </h1>
              <p>
                {page === "Overview"
                  ? "Build, test, and keep every strategy in sight."
                  : page === "Strategies"
                    ? "Turn your ideas into repeatable rules."
                    : page === "Brokers"
                      ? "One workspace. A future home for all your broker connections."
                      : page === "Orders & trades"
                        ? "Every simulated fill, with its strategy and execution price."
                        : page === "Activity log"
                          ? "A timeline of what changed in your workspace."
                          : "Build a useful project. Learn how each piece fits."}
              </p>
            </div>
            <Button
              onClick={() => {
                setFormError("");
                setModal(true);
              }}
            >
              <Plus size={17} /> New strategy
            </Button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <section
            className={`environment ${workspace.halted ? "is-paused" : ""}`}
          >
            <span className="environment-icon">
              <FlaskConical size={18} />
            </span>
            <div>
              <strong>
                {workspace.halted
                  ? "Paper workspace paused"
                  : "Your paper workspace"}
              </strong>
              <span>Sample price data · Simulated fills · No real money</span>
            </div>
            <span className="badge">LIVE DISABLED</span>
          </section>
          {(page === "Overview" || page === "Strategies") && (
            <>
              {page === "Overview" && (
                <>
                  <section className="metrics">
                    <article>
                      <div>
                        <span>Paper P&L</span>
                        <TrendingUp size={16} />
                      </div>
                      <h2 className={pnl >= 0 ? "positive" : "negative"}>
                        {money(pnl)}
                      </h2>
                      <p>Sum of each strategy’s latest replay</p>
                    </article>
                    <article>
                      <div>
                        <span>Configured capital</span>
                        <Wallet size={16} />
                      </div>
                      <h2>
                        {money(
                          workspace.strategies.reduce(
                            (n, s) => n + s.capital,
                            0,
                          ),
                        )}
                      </h2>
                      <p>Virtual allocation · not deposited funds</p>
                    </article>
                    <article>
                      <div>
                        <span>Strategies</span>
                        <Blocks size={16} />
                      </div>
                      <h2>
                        {workspace.strategies.length}
                        <small> configured</small>
                      </h2>
                      <p>
                        {
                          workspace.jobs.filter((j) =>
                            ["queued", "running"].includes(j.status),
                          ).length
                        }{" "}
                        replays in progress
                      </p>
                    </article>
                    <article>
                      <div>
                        <span>Broker connections</span>
                        <Radio size={16} />
                      </div>
                      <h2>
                        0<small> connected</small>
                      </h2>
                      <button
                        className="text-link"
                        onClick={() => setPage("Brokers")}
                      >
                        Explore integrations <ArrowRight size={13} />
                      </button>
                    </article>
                  </section>
                  <div className="overview-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h3>Performance</h3>
                          <p>Latest completed sample-data replay</p>
                        </div>
                        <span className="badge neutral">240 BARS</span>
                      </div>
                      <Chart values={latest?.result.equity || []} />
                      <div className="chart-footer">
                        <span>
                          <i /> Paper equity curve
                        </span>
                        <span>
                          {latest
                            ? `Max drawdown ${money(latest.result.drawdown || 0)}`
                            : "Waiting for your first replay"}
                        </span>
                      </div>
                    </section>
                    <section className="panel risk">
                      <div className="panel-heading">
                        <div>
                          <h3>Execution controls</h3>
                          <p>Built into the paper simulator</p>
                        </div>
                        <ShieldCheck size={20} />
                      </div>
                      <div className="risk-line">
                        <span className="icon-tile">
                          <SlidersHorizontal size={16} />
                        </span>
                        <div>
                          <strong>Replay loss threshold</strong>
                          <small>Stops new entries at 2% loss</small>
                        </div>
                        <span className="enabled">On</span>
                      </div>
                      <div className="risk-line">
                        <span className="icon-tile">
                          <Wallet size={16} />
                        </span>
                        <div>
                          <strong>Virtual capital limit</strong>
                          <small>Up to ₹5 lakh per strategy</small>
                        </div>
                        <span className="enabled">On</span>
                      </div>
                      <div className="pause-box">
                        <div>
                          <Pause size={15} />
                          <strong>Workspace pause</strong>
                        </div>
                        <p>Cancel pending replays and block new runs.</p>
                        <Button
                          variant={workspace.halted ? "secondary" : "danger"}
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              "/controls",
                              { halted: !workspace.halted },
                              workspace.halted
                                ? "Paper workspace resumed."
                                : "Paper workspace paused.",
                            )
                          }
                        >
                          {workspace.halted ? (
                            <Play size={14} />
                          ) : (
                            <Pause size={14} />
                          )}{" "}
                          {workspace.halted
                            ? "Resume paper workspace"
                            : "Pause all replays"}
                        </Button>
                      </div>
                    </section>
                  </div>
                </>
              )}
              <section className="panel strategies-panel">
                <div className="panel-heading">
                  <div>
                    <h3>
                      Your strategies{" "}
                      <span className="count">
                        {workspace.strategies.length}
                      </span>
                    </h3>
                    <p>EMA crossover · Long-only · Synthetic index units</p>
                  </div>
                  {page === "Overview" ? (
                    <button
                      className="text-link"
                      onClick={() => setPage("Strategies")}
                    >
                      View strategies <ArrowRight size={14} />
                    </button>
                  ) : (
                    <input
                      className="search-input"
                      aria-label="Search strategies"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search strategies…"
                    />
                  )}
                </div>
                {strategyTable}
              </section>
            </>
          )}
          {page === "Brokers" && (
            <section>
              <div className="brokers-grid">
                {["Zerodha Kite", "Dhan", "Upstox"].map((name, i) => (
                  <article className="panel broker" key={name}>
                    <span className={`broker-logo broker-${i}`}>{name[0]}</span>
                    <span className="badge neutral">PLANNED</span>
                    <h3>{name}</h3>
                    <p>
                      JavaScript adapters and broker authorization will be added in
                      the live integration phase.
                    </p>
                    <Button variant="secondary" disabled>
                      <LockKeyhole size={14} /> Integration coming later
                    </Button>
                  </article>
                ))}
              </div>
              <div className="info-note">
                <ShieldCheck size={18} />
                <p>
                  No broker is connected. This version does not collect or store
                  broker API credentials.
                </p>
              </div>
            </section>
          )}
          {page === "Orders & trades" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Simulated fills</h3>
                  <p>
                    Latest 30 runs · 0.05% slippage and ₹5 per order · taxes
                    excluded
                  </p>
                </div>
                <span className="badge purple">PAPER ONLY</span>
              </div>
              {!trades.length ? (
                <div className="empty">
                  <ArrowDownLeft size={30} />
                  <h3>No fills yet</h3>
                  <p>Run a paper replay to see entry and exit fills here.</p>
                  <Button
                    variant="secondary"
                    onClick={() => setPage("Strategies")}
                  >
                    Open strategies <ArrowRight size={14} />
                  </Button>
                </div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>STRATEGY</th>
                        <th>BAR</th>
                        <th>SIDE</th>
                        <th>UNITS</th>
                        <th>FILL PRICE</th>
                        <th>NET CLOSED P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t) => (
                        <tr key={t.id}>
                          <td>{t.strategy}</td>
                          <td>{t.bar + 1}</td>
                          <td>
                            <span
                              className={`badge ${t.side === "BUY" ? "green" : "purple"}`}
                            >
                              {t.side}
                            </span>
                          </td>
                          <td>{t.quantity}</td>
                          <td>{money(t.price)}</td>
                          <td
                            className={
                              (t.pnl || 0) >= 0 ? "positive" : "negative"
                            }
                          >
                            {t.pnl === null ? "—" : money(t.pnl)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {page === "Activity log" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Workspace activity</h3>
                  <p>Latest 50 events · stored in your database</p>
                </div>
                <Clock3 size={18} />
              </div>
              <div className="timeline">
                {workspace.events.map((e) => (
                  <div key={e.id}>
                    <span className="timeline-dot">
                      <Check size={12} />
                    </span>
                    <div>
                      <strong>{e.message}</strong>
                      <time>
                        {new Date(e.created_at).toLocaleString("en-IN")}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {page === "Learn the stack" && (
            <section className="learning-grid">
              {[
                [
                  Code2,
                  "01 / INTERFACE",
                  "Next.js + TypeScript",
                  "React renders this workspace. TypeScript describes the API data so the editor catches mismatched fields. Tailwind handles utility styles.",
                  "frontend/src/app/page.tsx",
                ],
                [
                  Zap,
                  "02 / API",
                  "Node.js + Express + TypeScript",
                  "Validates strategy settings, checks your owner session, and queues paper work. The browser never runs trading code.",
                  "backend/main.ts",
                ],
                [
                  Database,
                  "03 / STORAGE",
                  "SQL + PostgreSQL",
                  "SQLite keeps local setup light. Parameterized SQL supports PostgreSQL in Docker. Versioned migrations preserve your database.",
                  "backend/database.ts",
                ],
                [
                  Activity,
                  "04 / EXECUTION",
                  "Node.js paper worker",
                  "A separate process reads queued jobs, runs a deterministic price replay, and stores fills. It continues if you close the browser.",
                  "backend/worker.ts",
                ],
              ].map(([Icon, label, title, description, file]) => {
                const Symbol = Icon as typeof Code2;
                return (
                  <article className="panel learning-card" key={String(title)}>
                    <Symbol size={23} />
                    <span className="eyebrow">{String(label)}</span>
                    <h3>{String(title)}</h3>
                    <p>{String(description)}</p>
                    <code>{String(file)}</code>
                  </article>
                );
              })}
            </section>
          )}
          <footer>
            <span>
              <LockKeyhole size={12} /> Personal workspace · Paper research only
            </span>
            <span>
              Next.js + Node.js <span className="footer-dot">•</span> Built to
              grow with you
            </span>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialog}
        onCancel={() => setModal(false)}
        onClose={() => setModal(false)}
        className="strategy-dialog"
      >
        <form onSubmit={saveStrategy}>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close dialog"
            onClick={() => setModal(false)}
          >
            <X size={20} />
          </button>
          <span className="icon-tile">
            <Blocks size={23} />
          </span>
          <h2>Create a strategy</h2>
          <p>Define an EMA crossover and test it in your paper workspace.</p>
          {formError && (
            <div className="error" role="alert">
              {formError}
            </div>
          )}
          <label>
            Strategy name
            <input
              name="name"
              minLength={2}
              maxLength={60}
              required
              placeholder="e.g. NIFTY momentum"
              autoFocus
            />
          </label>
          <div className="form-grid">
            <label>
              Instrument
              <select name="symbol">
                <option>NIFTY</option>
                <option>BANKNIFTY</option>
                <option>SENSEX</option>
              </select>
            </label>
            <label>
              Virtual capital (₹)
              <input
                name="capital"
                type="number"
                min={1000}
                max={500000}
                step={1}
                defaultValue={100000}
                required
              />
            </label>
            <label>
              Fast EMA
              <input
                name="fast"
                type="number"
                min={2}
                max={40}
                defaultValue={9}
                required
              />
            </label>
            <label>
              Slow EMA
              <input
                name="slow"
                type="number"
                min={3}
                max={80}
                defaultValue={21}
                required
              />
            </label>
          </div>
          <div className="form-note">
            <FlaskConical size={16} />
            <span>Paper mode · Synthetic sample data · No broker required</span>
          </div>
          <Button className="w-full" disabled={busy}>
            {busy ? "Saving…" : "Create paper strategy"}
            <ArrowRight size={15} />
          </Button>
        </form>
      </dialog>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}
