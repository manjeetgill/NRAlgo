"use client";
/** Persistent personal lists; selecting an exact stored ID loads only that chart. */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { z } from "zod";
import { requestApiJson } from "@/lib/api";
import {
  StoredInstrumentPicker,
  type StoredInstrument,
} from "@/components/stored-instrument-picker";
import { Button } from "@/components/ui/button";
import { Select, Input } from "@/components/ui/field";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import styles from "./watchlists.module.css";
const Chart = dynamic(
  () => import("@/features/option-chain/contract-price-chart"),
  { ssr: false, loading: () => <p role="status">Loading chart…</p> },
);
const itemSchema = z.object({
  id: z.string().nullable(),
  symbol: z.string(),
  name: z.string(),
});
const responseSchema = z.object({
  lists: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      is_default: z.boolean(),
      items: z.array(itemSchema),
    }),
  ),
});
type Item = z.infer<typeof itemSchema>;
type List = z.infer<typeof responseSchema>["lists"][number];

export function WatchlistsScreen({ csrf }: { csrf: string }) {
  const [lists, setLists] = useState<List[]>([]);
  const [activeId, setActiveId] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [listVisible, setListVisible] = useState(true);
  const mounted = useRef(false);
  const pending = useRef(false);
  const toast = useToast();
  const active = lists.find((list) => list.id === activeId) ?? lists[0];
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    requestApiJson(
      "/watchlists",
      "GET",
      undefined,
      undefined,
      15000,
      abort.signal,
    )
      .then((value) => {
        if (abort.signal.aborted) {
          return;
        }
        const data = responseSchema.parse(value);
        setLists(data.lists);
        setActiveId(data.lists[0]?.id ?? "");
        setSelected(data.lists[0]?.items[0] ?? null);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Watchlists unavailable.",
          );
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [csrf]);
  async function mutate(
    path: string,
    method: "POST" | "DELETE",
    body: unknown,
    next?: Item,
    successMessage?: string,
  ) {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await requestApiJson(path, method, body, csrf);
      const data = responseSchema.parse(await requestApiJson("/watchlists"));
      if (!mounted.current) {
        return;
      }
      setLists(data.lists);
      if (path === "/watchlists") {
        const created = z.object({ id: z.string().uuid() }).parse(result);
        setActiveId(created.id);
        setSelected(null);
        setCreating(false);
        setName("");
        setAdding(true);
      } else if (deleting) {
        setActiveId(data.lists[0]?.id ?? "");
        setSelected(data.lists[0]?.items[0] ?? null);
        setDeleting(false);
      } else if (next) {
        setSelected(next);
        setAdding(false);
      } else if (
        selected &&
        !data.lists
          .find((list) => list.id === active?.id)
          ?.items.some(
            (item) =>
              item.id === selected.id && item.symbol === selected.symbol,
          )
      ) {
        setSelected(null);
      }
      if (successMessage) {
        toast({ tone: "success", title: successMessage });
      }
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error ? cause.message : "Watchlist update failed.",
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }
  function add(item: StoredInstrument) {
    if (active) {
      void mutate(
        `/watchlists/${active.id}/items`,
        "POST",
        { instrumentId: item.id },
        item,
        `${item.symbol} added to ${active.name}`,
      );
    }
  }
  return (
    <section className={styles.workspace} aria-label="Watchlists and chart">
      <div className={styles.mobileToggle}>
        <Button
          variant="secondary"
          aria-expanded={listVisible}
          aria-controls="watchlist-sidebar"
          onClick={() => setListVisible(!listVisible)}
        >
          {listVisible ? "Hide watchlist · expand chart" : "Show watchlist"}
        </Button>
        <span>{selected?.symbol ?? "No scrip selected"}</span>
      </div>
      <aside
        id="watchlist-sidebar"
        className={`${styles.sidebar} ${!listVisible ? styles.mobileHidden : ""}`}
        aria-label="Personal watchlists"
      >
        <div className={styles.toolbar}>
          <label className={styles.selector}>
            Watchlist
            <Select
              aria-label="Select watchlist"
              disabled={busy || loading}
              value={active?.id ?? ""}
              onChange={(event) => {
                const list = lists.find(
                  (value) => value.id === event.target.value,
                );
                setActiveId(event.target.value);
                setSelected(list?.items[0] ?? null);
                setAdding(false);
                setDeleting(false);
              }}
            >
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </Select>
          </label>
          <Button
            variant="secondary"
            disabled={busy || loading || lists.length >= 10}
            onClick={() => setCreating(!creating)}
          >
            New list
          </Button>
        </div>
        {creating && (
          <form
            className={styles.toolbar}
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                "/watchlists",
                "POST",
                { name: name.trim() },
                undefined,
                `Watchlist "${name.trim()}" created`,
              );
            }}
          >
            <Input
              aria-label="New watchlist name"
              placeholder="Watchlist name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <Button disabled={busy || !name.trim()}>Create</Button>
          </form>
        )}
        <div className={styles.toolbar}>
          <span>{active?.items.length ?? 0}/100 scrips</span>
          <Button
            variant="secondary"
            disabled={busy || !active}
            onClick={() => setAdding(!adding)}
          >
            {adding ? "Close search" : "+ Add scrip"}
          </Button>
        </div>
        {adding && (
          <div className={styles.search}>
            <StoredInstrumentPicker
              watchlist
              key={active?.id}
              disabled={busy}
              onSelect={add}
            />
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <AsyncBoundary
          status={loading ? "loading" : "success"}
          skeleton={
            <div style={{ padding: 12 }}>
              <SkeletonRows rows={4} columns={1} />
            </div>
          }
          isEmpty={!loading && (active?.items.length ?? 0) === 0}
          emptyTitle="No scrips yet"
          emptyDescription="Add a scrip to get started."
        >
          <ul className={styles.items} aria-label="Watchlist scrips">
            {active?.items.map((item) => (
              <li
                key={item.id ?? item.symbol}
                className={
                  selected?.id === item.id && selected?.symbol === item.symbol
                    ? styles.selected
                    : ""
                }
              >
                <button
                  className={styles.scrip}
                  aria-pressed={
                    selected?.id === item.id && selected?.symbol === item.symbol
                  }
                  onClick={() => setSelected(item)}
                >
                  <strong>{item.name}</strong>
                </button>
                <button
                  className={styles.remove}
                  aria-label={`Remove ${item.symbol} from watchlist`}
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/watchlists/${active.id}/items`,
                      "DELETE",
                      { id: item.id, symbol: item.symbol },
                      undefined,
                      `${item.symbol} removed from ${active.name}`,
                    )
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </AsyncBoundary>
        {active && !active.is_default && (
          <div className={styles.footer}>
            {deleting ? (
              <>
                <p>Delete “{active.name}” and its saved scrips?</p>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/watchlists/${active.id}`,
                      "DELETE",
                      undefined,
                      undefined,
                      `Watchlist "${active.name}" deleted`,
                    )
                  }
                >
                  Delete list
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setDeleting(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <button disabled={busy} onClick={() => setDeleting(true)}>
                Delete watchlist
              </button>
            )}
          </div>
        )}
      </aside>
      <div className={styles.chart} aria-label="Selected scrip chart">
        {selected?.id ? (
          <Chart key={selected.id} eodId={selected.id} csrf={csrf} />
        ) : (
          <EmptyState
            title={selected ? "No stored history" : "Select a scrip"}
            description={
              selected
                ? `Stored history for ${selected.symbol} is not available yet. Search and add it after importing data.`
                : "Select a scrip to open its chart."
            }
          />
        )}
      </div>
    </section>
  );
}
