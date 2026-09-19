/** Owner-scoped durable calculation jobs and the Python worker coordinator.
 * Node selects stored datasets and validates results; Python receives no credentials.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./database.js";
import {
  CalculationClient,
  calculationBacktestSettingsSchema,
  payoffRequestSchema,
} from "./calculation-client.js";
import { fail, rateLimit } from "./security.js";

const identity = z.uuid();
const dailyJobInputSchema = z
  .object({
    instrumentId: z.string().min(1).max(120),
    symbol: z.string().min(1).max(60),
    from: z.iso.date(),
    to: z.iso.date(),
    settings: calculationBacktestSettingsSchema,
  })
  .strict()
  .refine((input) => input.from <= input.to, {
    message: "Historical range is reversed.",
  });
type DailyJobInput = z.infer<typeof dailyJobInputSchema>;
type CalculationJobRow = {
  id: string;
  user_id: string;
  kind: "daily-backtest";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  input: string;
  result: string;
  error: string;
  cancel_requested: boolean;
  engine_version: string;
  created_at: Date | string;
  updated_at: Date | string;
};
type StoredBar = {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
};

/** Produce stable UTF-8 hashes for reproducible calculation manifests. */
function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Expose only the owner's bounded job state; raw worker input remains server-side. */
function presentJob(row: CalculationJobRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    engineVersion: row.engine_version || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error || null,
  };
}

/** Execute one durable job at a time in this single-instance deployment. */
export class CalculationJobRunner {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private running = false;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly client: Pick<CalculationClient, "dailyBacktest">,
  ) {}

  /** Recover interrupted CPU-only work safely, then start bounded serial polling. */
  public start() {
    void this.store
      .transaction((query) =>
        query(
          "UPDATE calculation_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END,progress=CASE WHEN cancel_requested THEN 0 ELSE 5 END,error=CASE WHEN cancel_requested THEN '' ELSE 'Worker restarted before completion; calculation safely requeued.' END,updated_at=NOW() WHERE status='running'",
        ),
      )
      .finally(() => this.schedule(0));
  }

  /** Stop accepting work and abort only calculation HTTP calls, never broker operations. */
  public close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const controller of this.controllers.values()) {
      controller.abort(
        new DOMException("Calculation worker stopped", "AbortError"),
      );
    }
    this.controllers.clear();
  }

  /** Persist cancellation and interrupt an active private service request when possible. */
  public async cancel(userId: string, jobId: string) {
    const [job] = await this.store.transaction((query) =>
      query<CalculationJobRow>(
        "UPDATE calculation_jobs SET cancel_requested=TRUE,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,progress=CASE WHEN status='queued' THEN 0 ELSE progress END,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('queued','running') RETURNING *",
        [jobId, userId],
      ),
    );
    if (!job) {
      fail(409, "Calculation is already terminal or unavailable.");
    }
    this.controllers
      .get(jobId)
      ?.abort(new DOMException("Calculation cancelled", "AbortError"));
    return presentJob(job);
  }

  /** Schedule the next non-overlapping claim; empty queues back off without busy polling. */
  private schedule(delay = 300) {
    if (this.closed) {
      return;
    }
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }

  /** Claim via SKIP LOCKED so a future multi-worker deployment cannot double-run a job. */
  private async claim() {
    return this.store.transaction(async (query) => {
      const [job] = await query<CalculationJobRow>(
        "SELECT * FROM calculation_jobs WHERE status='queued' AND NOT cancel_requested ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      if (!job) {
        return null;
      }
      const [claimed] = await query<CalculationJobRow>(
        "UPDATE calculation_jobs SET status='running',progress=10,error='',updated_at=NOW() WHERE id=$1 AND status='queued' RETURNING *",
        [job.id],
      );
      return claimed ?? null;
    });
  }

  /** Run a claimed job and always persist one terminal state or a recoverable failure. */
  private async tick() {
    if (this.closed || this.running) {
      this.schedule();
      return;
    }
    this.running = true;
    let found = false;
    try {
      const job = await this.claim();
      if (job) {
        found = true;
        await this.execute(job);
      }
    } catch {
      // Database/service errors are reflected on the claimed job when possible; keep the worker alive.
    } finally {
      this.running = false;
      this.schedule(found ? 0 : 500);
    }
  }

  /** Select the exact stored dataset and send only bars/settings to Python. */
  private async execute(job: CalculationJobRow) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const input = dailyJobInputSchema.parse(JSON.parse(job.input));
      const dataset = await this.loadDataset(job.id, input);
      const response = await this.client.dailyBacktest(
        dataset.bars,
        input.settings,
        controller.signal,
      );
      const result = {
        ...response.result,
        manifest: {
          schemaVersion: 3,
          engineVersion: response.engineVersion,
          templateId: input.settings.template,
          templateVersion: "1.0.0",
          datasetHash: sha256(dataset.bars),
          configurationHash: sha256(input.settings),
          provider: dataset.sources.join(", ") || "Stored historical dataset",
          request: {
            market: "cash",
            stockCode: input.symbol,
            instrument: input.instrumentId,
            from: input.from,
            to: input.to,
            interval: "day",
          },
          fetchedAt: new Date().toISOString(),
          rowCount: dataset.bars.length,
          timeframe: "1d",
          source: "Stored historical database",
          provenance:
            "Node-selected operator-imported dataset; Python received no broker credentials",
          adjustmentPolicy: dataset.adjustmentPolicy,
          storage: "Owner-scoped PostgreSQL calculation job",
          createdAt: new Date().toISOString(),
        },
      };
      await this.store.transaction(async (query) => {
        const [current] = await query<{ cancel_requested: boolean }>(
          "SELECT cancel_requested FROM calculation_jobs WHERE id=$1 FOR UPDATE",
          [job.id],
        );
        await query(
          current?.cancel_requested
            ? "UPDATE calculation_jobs SET status='cancelled',progress=0,result='',error='',updated_at=NOW() WHERE id=$1"
            : "UPDATE calculation_jobs SET status='completed',progress=100,result=$2,error='',engine_version=$3,updated_at=NOW() WHERE id=$1",
          current?.cancel_requested
            ? [job.id]
            : [job.id, JSON.stringify(result), response.engineVersion],
        );
      });
    } catch (cause) {
      const cancelled = controller.signal.aborted;
      const detail = cancelled
        ? ""
        : cause instanceof Error && cause.message.length <= 300
          ? cause.message
          : "Calculation failed validation or became unavailable.";
      await this.store
        .transaction((query) =>
          cancelled
            ? query(
                "UPDATE calculation_jobs SET status='cancelled',progress=0,error='',updated_at=NOW() WHERE id=$1 AND status='running'",
                [job.id],
              )
            : query(
                "UPDATE calculation_jobs SET status='failed',error=$2,updated_at=NOW() WHERE id=$1 AND status='running'",
                [job.id, detail],
              ),
        )
        .catch(() => {});
    } finally {
      this.controllers.delete(job.id);
    }
  }

  /** Load bounded, ordered candles after matching both stable identity and symbol. */
  private async loadDataset(jobId: string, input: DailyJobInput) {
    return this.store.transaction(async (query) => {
      const [instrument] = await query<{ id: string; symbol: string }>(
        "SELECT id,symbol FROM eod_instruments WHERE id=$1 AND symbol=$2",
        [input.instrumentId, input.symbol],
      );
      if (!instrument) {
        throw new Error("Stored instrument is unavailable.");
      }
      const rows = await query<StoredBar>(
        "SELECT day::text AS day,open,high,low,close,source FROM eod_candles WHERE instrument_id=$1 AND day>=$2::date AND day<=$3::date ORDER BY day LIMIT 10001",
        [input.instrumentId, input.from, input.to],
      );
      if (rows.length < 60 || rows.length > 10000) {
        throw new Error("Requires 60–10,000 stored daily candles.");
      }
      await query(
        "UPDATE calculation_jobs SET progress=30,updated_at=NOW() WHERE id=$1 AND status='running'",
        [jobId],
      );
      return {
        bars: rows.map((row) => ({
          date: row.day,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
        })),
        sources: [
          ...new Set(
            rows.map((row) =>
              row.source.startsWith("local-dataset:")
                ? "Stored historical dataset"
                : row.source,
            ),
          ),
        ],
        adjustmentPolicy: rows.some((row) =>
          row.source.startsWith("local-dataset:"),
        )
          ? "Adjustment policy unknown; verify the stored dataset before relying on returns."
          : "Stored prices are unadjusted.",
      };
    });
  }
}

/** Register authenticated job lifecycle and synchronous bounded payoff calculations. */
export function registerCalculationRoutes(
  app: Express,
  store: Store,
  runner: CalculationJobRunner,
  client: Pick<CalculationClient, "payoff">,
) {
  const limit = rateLimit(30, 60000, (req) => req.res!.locals.session.user_id);
  app.post("/api/calculations/backtests", limit, async (req, res) => {
    const input = dailyJobInputSchema.parse(req.body);
    const userId = res.locals.session.user_id;
    const id = randomUUID();
    await store.transaction(async (query) => {
      const [count] = await query<{ count: string }>(
        "SELECT COUNT(*) FROM calculation_jobs WHERE user_id=$1 AND status IN ('queued','running')",
        [userId],
      );
      if (Number(count.count) >= 5) {
        fail(429, "Wait for an existing calculation or cancel it first.");
      }
      await query(
        "INSERT INTO calculation_jobs(id,user_id,kind,status,progress,input) VALUES($1,$2,'daily-backtest','queued',0,$3)",
        [id, userId, JSON.stringify(input)],
      );
      await query(
        "DELETE FROM calculation_jobs WHERE user_id=$1 AND status IN ('completed','failed','cancelled') AND id NOT IN (SELECT id FROM calculation_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50)",
        [userId],
      );
    });
    res.status(202).json({ id, status: "queued", progress: 0 });
  });
  app.get("/api/calculations/jobs/:id", limit, async (req, res) => {
    const [job] = await store.transaction((query) =>
      query<CalculationJobRow>(
        "SELECT * FROM calculation_jobs WHERE id=$1 AND user_id=$2",
        [identity.parse(req.params.id), res.locals.session.user_id],
      ),
    );
    if (!job) {
      fail(404, "Calculation job not found.");
    }
    res.json(presentJob(job));
  });
  app.delete("/api/calculations/jobs/:id", async (req, res) => {
    res.json(
      await runner.cancel(
        res.locals.session.user_id,
        identity.parse(req.params.id),
      ),
    );
  });
  app.post("/api/calculations/payoff", limit, async (req, res) => {
    const cancellation = new AbortController();
    const close = () => {
      if (!res.writableEnded) {
        cancellation.abort(
          new DOMException("Client disconnected", "AbortError"),
        );
      }
    };
    res.once("close", close);
    try {
      const response = await client.payoff(
        payoffRequestSchema.parse(req.body),
        cancellation.signal,
      );
      res.json(response);
    } finally {
      res.removeListener("close", close);
    }
  });
}
