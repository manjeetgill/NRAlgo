"use client";

/** Automatically loaded, read-only NSE reference intelligence for Overview. */
import { useEffect, useState, type ChangeEvent } from "react";
import { BarChart3 } from "lucide-react";
import { requestApiJson } from "@/lib/api";
import { z } from "zod";
import styles from "./nse-market-intelligence.module.css";

const datasetGroups: ReadonlyArray<{
  label: string;
  options: ReadonlyArray<{ value: MarketInsightDataset; label: string }>;
}> = [
  {
    label: "Most active options",
    options: [
      { value: "active-index-calls", label: "Index calls" },
      { value: "active-index-puts", label: "Index puts" },
      { value: "active-stock-calls", label: "Stock calls" },
      { value: "active-stock-puts", label: "Stock puts" },
      { value: "active-derivatives-oi", label: "Derivatives by OI" },
      { value: "active-derivatives-volume", label: "Derivatives by volume" },
    ],
  },
  {
    label: "Institutional activity",
    options: [{ value: "fii-dii", label: "FII / DII activity" }],
  },
  {
    label: "Equity and corporate data",
    options: [
      { value: "active-equities-value", label: "Equities by value" },
      { value: "corporate-actions", label: "Corporate actions" },
      { value: "corporate-announcements", label: "Announcements" },
      { value: "upcoming-results", label: "Upcoming results" },
    ],
  },
];

const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 600;

/** Convert a signed NSE metric into a restrained visual signal. */
function metricTone(label: string, value: string) {
  if (!/^(change %|net)$/i.test(label)) {
    return "neutral";
  }
  const numeric = Number(value.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(numeric) && numeric !== 0
    ? numeric > 0
      ? "positive"
      : "negative"
    : "neutral";
}

/** Present numeric exchange fields in compact Indian grouping instead of scientific notation. */
function metricValue(label: string, value: string) {
  if (!/^(buy|sell|net|last|strike|volume|oi|value|change %)$/i.test(label)) {
    return value;
  }
  const numeric = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return value;
  }
  const formatted = numeric.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
  return /^change %$/i.test(label) ? `${formatted}%` : formatted;
}

/** Fetch one allowlisted NSE dataset on mount and whenever its selector changes. */
export function NseMarketIntelligence() {
  const [dataset, setDataset] = useState<MarketInsightDataset>("fii-dii");
  const [result, setResult] = useState<MarketInsightResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  /** A dataset change is sufficient user intent; the effect owns the resulting request. */
  function onDatasetChange(event: ChangeEvent<HTMLSelectElement>) {
    setDataset(marketInsightDatasetSchema.parse(event.target.value));
  }

  /**
   * Cancel superseded reads and retry short-lived service contention without requiring
   * a manual load button. The bounded delay keeps permanent upstream failures visible.
   */
  useEffect(() => {
    const controller = new AbortController();
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    setLoading(true);
    setError("");
    setResult(null);

    /** Wait before retrying a transient read while remaining cancellable on navigation. */
    function waitForRetry(delayMs: number) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          resolve();
        }, delayMs);
        retryTimers.add(timer);
      });
    }

    /** Fetch, validate and publish only the latest selected NSE dataset. */
    async function loadDataset() {
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
        try {
          const response = await requestApiJson(
            `/market/insights/${dataset}`,
            "GET",
            undefined,
            undefined,
            30000,
            controller.signal,
          );
          const parsed = marketInsightResponseSchema.parse(response);
          if (!controller.signal.aborted) {
            setResult(parsed);
            setLoading(false);
          }
          return;
        } catch (cause) {
          if (controller.signal.aborted) {
            return;
          }
          lastError = cause;
          if (attempt + 1 < MAX_REQUEST_ATTEMPTS) {
            await waitForRetry(RETRY_BASE_DELAY_MS * 2 ** attempt);
          }
        }
      }
      if (!controller.signal.aborted) {
        setResult(null);
        setError(
          lastError instanceof Error
            ? lastError.message
            : "NSE market intelligence is unavailable.",
        );
        setLoading(false);
      }
    }

    void loadDataset();
    return () => {
      controller.abort();
      retryTimers.forEach((timer) => clearTimeout(timer));
      retryTimers.clear();
    };
  }, [dataset]);

  return (
    <section className={styles.panel} aria-label="NSE market intelligence">
      <header className={styles.heading}>
        <div>
          <h2>
            <BarChart3 size={17} aria-hidden="true" /> NSE market intelligence
          </h2>
          <p>Public exchange reference data · read only</p>
        </div>
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
        <span className={styles.status} aria-live="polite">
          {loading ? "Loading NSE…" : result ? "NSE loaded" : "Unavailable"}
        </span>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className={styles.results} aria-busy={loading}>
          <div className={styles.resultHeading}>
            <strong>{result.label}</strong>
            <time dateTime={new Date(result.observedAt).toISOString()}>
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
                      <div
                        key={field.label}
                        data-tone={metricTone(field.label, field.value)}
                      >
                        <dt>{field.label}</dt>
                        <dd>{metricValue(field.label, field.value)}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>No rows were returned by NSE.</p>
          )}
          <p className={styles.warning}>{result.warning}</p>
        </div>
      )}
    </section>
  );
}

/** Browser-visible datasets mirror the server's bounded, read-only allowlist. */
const marketInsightDatasetSchema = z.enum([
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
type MarketInsightDataset = z.infer<typeof marketInsightDatasetSchema>;

const marketInsightResponseSchema = z
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
type MarketInsightResponse = z.infer<typeof marketInsightResponseSchema>;
