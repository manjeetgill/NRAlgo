"use client";
/** Legacy synthetic strategy tools, isolated from the live workspace and broker execution controls. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  Blocks,
  FlaskConical,
  Play,
  Plus,
  TrendingUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestApiJson } from "@/lib/api";
import { formatInr as money } from "@/lib/format";
import type { WorkspaceSnapshot } from "@/features/workspace/workspace-types";
/** Keep form state local; paper orders cannot be created from another screen's shared modal. */
export function PaperStrategiesScreen({
  workspace,
  onRefresh,
}: {
  workspace: WorkspaceSnapshot;
  onRefresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const actionPending = useRef(false);
  /** Synchronize the native modal with its React state; the modal has no network lifecycle. */
  useEffect(() => {
    if (modal) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [modal]);
  /** Submit once, then reload the server's authoritative research status; never retry a failed mutation. */
  const submitWorkspaceAction = useCallback(
    async (path: string, data: unknown, message: string) => {
      if (actionPending.current) {
        return;
      }
      actionPending.current = true;
      setBusy(true);
      setFormError("");
      try {
        await requestApiJson(path, "POST", data, workspace.csrf);
        await onRefresh();
        setNotice(message);
      } catch (cause) {
        setFormError(
          cause instanceof Error ? cause.message : "Research action failed.",
        );
      } finally {
        actionPending.current = false;
        setBusy(false);
      }
    },
    [workspace.csrf, onRefresh],
  );
  /** Convert numeric form fields and create a paper-only strategy; server validation remains decisive. */
  async function onSaveStrategy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionPending.current) {
      return;
    }
    actionPending.current = true;
    setBusy(true);
    setFormError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await requestApiJson(
        "/strategies",
        "POST",
        {
          ...data,
          capital: Number(data.capital),
          fast: Number(data.fast),
          slow: Number(data.slow),
          mode: "paper",
        },
        workspace.csrf,
      );
      await onRefresh();
      setModal(false);
      setNotice("Strategy saved. Ready for a sample-data replay.");
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }

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
                        void submitWorkspaceAction(
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
    <>
      {formError && !modal && <p role="alert">{formError}</p>}
      {notice && <p role="status">{notice}</p>}
      <section className="panel strategies-panel">
        <div className="panel-heading">
          <div>
            <h3>
              Your strategies{" "}
              <span className="count">{workspace.strategies.length}</span>
            </h3>
            <p>EMA crossover · Long-only · Synthetic index units</p>
          </div>
          <input
            className="search-input"
            aria-label="Search strategies"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search strategies…"
          />
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setFormError("");
              setModal(true);
            }}
          >
            <Plus size={15} /> New strategy
          </Button>
        </div>
        {strategyTable}
      </section>

      <dialog
        ref={dialog}
        onCancel={() => setModal(false)}
        onClose={() => setModal(false)}
        className="strategy-dialog"
      >
        <form onSubmit={onSaveStrategy}>
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
    </>
  );
}
