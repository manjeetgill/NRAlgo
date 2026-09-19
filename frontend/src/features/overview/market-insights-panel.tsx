"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { requestApiJson } from "@/lib/api";
import { z } from "zod";
import styles from "@/features/overview/market-insights-panel.module.css";

const datasetGroups: ReadonlyArray<{
  label: string;
  options: ReadonlyArray<{ value: MarketInsightDataset; label: string }>;
}> = [
  {
    label: "Institutional activity",
    options: [{ value: "fii-dii", label: "FII / DII activity" }],
  },
  {
    label: "Corporate data",
    options: [
      { value: "corporate-actions", label: "Corporate actions" },
      { value: "corporate-announcements", label: "Announcements" },
      { value: "upcoming-results", label: "Upcoming results" },
    ],
  },
  {
    label: "Most active scans",
    options: [
      { value: "active-equities-value", label: "Equities by value" },
      { value: "active-index-calls", label: "Index calls" },
      { value: "active-index-puts", label: "Index puts" },
      { value: "active-stock-calls", label: "Stock calls" },
      { value: "active-stock-puts", label: "Stock puts" },
      { value: "active-derivatives-oi", label: "Derivatives by OI" },
      { value: "active-derivatives-volume", label: "Derivatives by volume" },
    ],
  },
];

/** Explicit, read-only NSE reference-data viewer; it never polls or offers execution actions. */
export function MarketInsightsPanel() {
  const [dataset, setDataset] = useState<MarketInsightDataset>("fii-dii");
  const [result, setResult] = useState<MarketInsightResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pendingRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      pendingRequest.current?.abort();
    },
    [],
  );

  function onDatasetChange(event: ChangeEvent<HTMLSelectElement>) {
    pendingRequest.current?.abort();
    setDataset(marketInsightDatasetSchema.parse(event.target.value));
    setResult(null);
    setError("");
    setLoading(false);
  }

  async function loadDataset() {
    pendingRequest.current?.abort();
    const controller = new AbortController();
    pendingRequest.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await requestApiJson(
        `/market/insights/${dataset}`,
        "GET",
        undefined,
        undefined,
        30000,
        controller.signal,
      );
      if (pendingRequest.current === controller) {
        setResult(marketInsightResponseSchema.parse(response));
      }
    } catch (cause) {
      if (!controller.signal.aborted && pendingRequest.current === controller) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Market intelligence is unavailable.",
        );
      }
    } finally {
      if (pendingRequest.current === controller) {
        pendingRequest.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <section className={styles.panel} aria-label="NSE market intelligence">
      <div className={styles.heading}>
        <div>
          <h2>
            <BarChart3 size={18} /> NSE market intelligence
          </h2>
          <p>Public reference data loaded only when you ask for it.</p>
        </div>
        <div className={styles.controls}>
          <label>
            Dataset
            <select value={dataset} onChange={onDatasetChange}>
              {datasetGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button disabled={loading} onClick={() => void loadDataset()}>
            <RefreshCw size={14} aria-hidden="true" />
            {loading ? "Loading…" : result ? "Refresh" : "Load data"}
          </button>
        </div>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!result && !error && (
        <p className={styles.placeholder}>
          Choose a dataset and select Load data. No request is made
          automatically.
        </p>
      )}
      {result && (
        <div className={styles.results}>
          <div className={styles.resultHeading}>
            <strong>{result.label}</strong>
            <time dateTime={new Date(result.observedAt).toISOString()}>
              Loaded{" "}
              {new Date(result.observedAt).toLocaleTimeString("en-IN", {
                timeZone: "Asia/Kolkata",
              })}{" "}
              IST
            </time>
          </div>
          {result.items.length ? (
            <ul className={styles.items}>
              {result.items.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                  <div className={styles.identity}>
                    <strong>{item.title}</strong>
                    {item.subtitle && <span>{item.subtitle}</span>}
                  </div>
                  <dl>
                    {item.values.map((field) => (
                      <div key={field.label}>
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.placeholder}>No rows were returned.</p>
          )}
          <p className={styles.warning}>{result.warning}</p>
        </div>
      )}
    </section>
  );
}

/** Browser-visible datasets are fixed to the same read-only server allowlist. */
export const marketInsightDatasetSchema = z.enum([
  "fii-dii",
  "corporate-actions",
  "corporate-announcements",
  "upcoming-results",
  "active-equities-value",
  "active-index-calls",
  "active-index-puts",
  "active-stock-calls",
  "active-stock-puts",
  "active-derivatives-oi",
  "active-derivatives-volume",
]);
export type MarketInsightDataset = z.infer<typeof marketInsightDatasetSchema>;

export const marketInsightResponseSchema = z
  .object({
    dataset: marketInsightDatasetSchema,
    label: z.string().min(1).max(100),
    provider: z.literal("nsefin"),
    observedAt: z.number().int().nonnegative(),
    items: z
      .array(
        z
          .object({
            title: z.string().min(1).max(160),
            subtitle: z.string().max(160).nullable(),
            values: z
              .array(
                z
                  .object({
                    label: z.string().min(1).max(40),
                    value: z.string().min(1).max(160),
                  })
                  .strict(),
              )
              .max(5),
          })
          .strict(),
      )
      .max(12),
    warning: z.string().min(1).max(300),
  })
  .strict();

export type MarketInsightResponse = z.infer<typeof marketInsightResponseSchema>;
