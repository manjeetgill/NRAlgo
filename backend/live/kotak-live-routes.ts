/** Mounted only behind main.ts authentication + CSRF. No caller-controlled owner or broker URL. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { rateLimit } from "../security.js";
import { instrumentSearchSchema } from "../instrument-master.js";
import { orderIntentSchema, riskLimitsSchema } from "./contracts.js";
import type { KotakLiveManager } from "./kotak-live-manager.js";

export function registerKotakLiveRoutes(
  app: Express,
  manager: KotakLiveManager,
) {
  // Halt is deliberately not subjected to the lower per-live-action budget.
  const limit = rateLimit(20, 60000, (req) => req.res!.locals.session.user_id);
  const handle =
    (action: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.json(await action(req, res));
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(422).json({ detail: "Invalid live execution fields." });
          return;
        }
        const safe = error as { status?: number; detail?: string };
        res
          .status(safe.status ?? 409)
          .json({
            detail:
              safe.detail ??
              "Live action blocked. Check connection, current contract master, risk limits and reconciliation status. No automatic order retry.",
          });
      }
    };
  app.get(
    "/api/live/status",
    handle((_req, res) => manager.status(res.locals.session)),
  );
  app.post(
    "/api/live/instruments",
    limit,
    handle((req, res) =>
      manager.instruments(
        res.locals.session,
        instrumentSearchSchema.parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/live/configure",
    limit,
    handle((req, res) =>
      manager.configure(res.locals.session, riskLimitsSchema.parse(req.body)),
    ),
  );
  app.post(
    "/api/live/reconcile",
    limit,
    handle((_req, res) => manager.reconcile(res.locals.session)),
  );
  app.post(
    "/api/live/arm",
    limit,
    handle((req, res) => {
      const input = z
        .object({
          token: z.string().min(6).max(32),
          confirmation: z.literal("ENABLE REAL MONEY"),
        })
        .strict()
        .parse(req.body);
      return manager.arm(res.locals.session, input.token);
    }),
  );
  app.post(
    "/api/live/preview",
    limit,
    handle((req, res) =>
      manager.preview(
        res.locals.session,
        orderIntentSchema.omit({ key: true }).parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/live/orders",
    limit,
    handle((req, res) => {
      const input = z
        .object({
          previewId: z.uuid(),
          confirmation: z.literal("PLACE LIVE ORDER"),
        })
        .strict()
        .parse(req.body);
      return manager.submit(res.locals.session, input.previewId);
    }),
  );
  app.post(
    "/api/live/halt",
    handle((_req, res) => manager.halt(res.locals.session)),
  );
}
