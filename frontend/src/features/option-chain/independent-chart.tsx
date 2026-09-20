"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Dialog } from "@/components/ui/dialog";
import { requestApiJson } from "@/lib/api";
import styles from "./independent-chart.module.css";
const Chart = dynamic(() => import("./contract-price-chart"), {
  ssr: false,
  loading: () => <p role="status">Loading chart…</p>,
});
const resultSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      name: z.string(),
      kind: z.string(),
      series: z.string(),
    }),
  ),
  nextOffset: z.number().nullable(),
});
type Item = z.infer<typeof resultSchema>["items"][number];
/** Search the imported catalog, not broker credentials or execution tokens. */
export function IndependentChart() {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<z.infer<typeof resultSchema> | null>(
    null,
  );
  const [selected, setSelected] = useState<Item | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2) {
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const data = resultSchema.parse(
          await requestApiJson(
            `/eod/instruments?q=${encodeURIComponent(query.trim())}&offset=${offset}`,
            "GET",
            undefined,
            undefined,
            15000,
            abort.signal,
          ),
        );
        if (!abort.signal.aborted) {
          setResult(data);
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : "Search unavailable.");
        }
      } finally {
        if (!abort.signal.aborted) {
          setBusy(false);
        }
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, offset]);
  return (
    <>
      <section className={styles.panel} aria-label="Charts without a broker">
        <h2>Daily charts · no broker required</h2>
        <p>Search a scrip and select a match to open its chart.</p>
        <Field label="Search stored scrips" htmlFor="independent-chart-search">
          <Input
            id="independent-chart-search"
            value={query}
            maxLength={60}
            placeholder="Type REL or NIFTY…"
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
              setResult(null);
              setSelected(null);
              setError("");
              setBusy(false);
            }}
          />
        </Field>
        {busy && (
          <p className={styles.status} role="status">
            Searching stored instruments…
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {result && !busy && (
          <>
            {result.items.length ? (
              <ul className={styles.results} aria-label="Matching instruments">
                {result.items.map((item) => (
                  <li key={item.id}>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSelected(item);
                        setOpened(true);
                      }}
                    >
                      {item.symbol} · {item.kind} {item.series} · {item.name}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.status} role="status">
                No matching scrips. Try another name or symbol.
              </p>
            )}
            <div className={styles.pager}>
              {offset > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setResult(null);
                    setSelected(null);
                    setOffset(Math.max(0, offset - 50));
                  }}
                >
                  Previous matches
                </Button>
              )}
              {result.nextOffset !== null && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOffset(result.nextOffset!);
                    setSelected(null);
                    setResult(null);
                  }}
                >
                  More matches
                </Button>
              )}
            </div>
          </>
        )}
      </section>
      <Dialog
        open={opened}
        onClose={() => setOpened(false)}
        title="Daily price chart"
        labelledBy="independent-chart-title"
        className={styles.wideDialog}
      >
        {opened && selected && <Chart key={selected.id} eodId={selected.id} />}
      </Dialog>
    </>
  );
}
