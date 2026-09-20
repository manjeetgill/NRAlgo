/** TradingView alerts create user-owned drafts only. This module has no broker dependency and
 * deliberately exposes no endpoint that can preview, reserve, or submit an order. */
import { randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { audit, type Store } from "./database.js";
import { digest, equal, fail, rateLimit } from "./security.js";

const alertSchema = z
  .object({
    alertId: z.string().trim().min(1).max(160),
    symbol: z.string().trim().min(1).max(120),
    market: z.enum(["CASH", "OPTIONS", "cash", "options"]),
    side: z.enum(["BUY", "SELL", "buy", "sell"]),
    orderType: z.enum(["MARKET", "LIMIT", "market", "limit"]),
    quantity: z.number().int().positive().max(1000000),
    limitPrice: z.number().finite().positive().max(21474836.47).optional(),
    strategy: z.string().trim().max(120).default(""),
    triggeredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.orderType.toLowerCase() === "limit" && !value.limitPrice) {
      ctx.addIssue({ code: "custom", message: "Limit price is required." });
    }
    if (
      value.orderType.toLowerCase() === "market" &&
      value.limitPrice !== undefined
    ) {
      ctx.addIssue({ code: "custom", message: "Market drafts omit price." });
    }
  });

const actionSchema = z
  .object({ status: z.enum(["accepted", "dismissed"]) })
  .strict();

type HookRow = { user_id: string; secret_hash: string };

/** Authenticate, validate and persist one provider delivery without constructing any broker intent. */
export async function receiveTradingViewAlert(
  store: Store,
  key: string,
  body: unknown,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
    return false;
  }
  const [hook] = await store.transaction((query) =>
    query<HookRow>(
      "SELECT user_id,secret_hash FROM tradingview_webhooks WHERE secret_hash=$1",
      [digest(key)],
    ),
  );
  if (!hook || !equal(digest(key), hook.secret_hash)) {
    return false;
  }
  const input = alertSchema.parse(body);
  const orderType = input.orderType.toLowerCase() as "market" | "limit";
  const limitPaise = input.limitPrice
    ? Math.round(input.limitPrice * 100)
    : null;
  await store.transaction(async (query) => {
    const created = await query<{ id: string }>(
      "INSERT INTO tradingview_order_drafts (id,user_id,external_alert_id,symbol,market,side,order_type,quantity,limit_paise,strategy,triggered_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') ON CONFLICT(user_id,external_alert_id) DO NOTHING RETURNING id",
      [
        randomUUID(),
        hook.user_id,
        input.alertId,
        input.symbol,
        input.market.toLowerCase(),
        input.side.toLowerCase(),
        orderType,
        input.quantity,
        limitPaise,
        input.strategy,
        input.triggeredAt,
      ],
    );
    if (!created.length) {
      return;
    }
    await audit(
      query,
      `TradingView alert received: ${input.symbol} ${input.side.toUpperCase()} draft created.`,
      hook.user_id,
    );
  });
  return true;
}

/** Register the public receiver before session middleware; the opaque, per-user secret is its
 * only authority. Requests return quickly because TradingView cancels slow webhook deliveries. */
export function registerTradingViewWebhookReceiver(app: Express, store: Store) {
  const receiverLimit = rateLimit(30, 60000, (req) =>
    typeof req.params.key === "string" ? req.params.key : "missing",
  );
  app.post(
    "/hooks/tradingview/:key",
    receiverLimit,
    async (req: Request, res: Response) => {
      const key = typeof req.params.key === "string" ? req.params.key : "";
      if (!(await receiveTradingViewAlert(store, key, req.body))) {
        res.status(404).json({ detail: "Webhook not found." });
        return;
      }
      res.status(202).json({ accepted: true });
    },
  );
}

/** Authenticated owner controls and reads for non-executable alert drafts. */
export function registerTradingViewRoutes(
  app: Express,
  store: Store,
  origin: string,
) {
  app.post("/api/tradingview/webhook", async (_req, res) => {
    const userId = res.locals.session.user_id;
    const secret = randomBytes(32).toString("base64url");
    await store.transaction(async (query) => {
      await query("DELETE FROM tradingview_webhooks WHERE user_id=$1", [
        userId,
      ]);
      await query(
        "INSERT INTO tradingview_webhooks (user_id,secret_hash) VALUES ($1,$2)",
        [userId, digest(secret)],
      );
      await audit(
        query,
        "TradingView webhook key generated. Previous key revoked.",
        userId,
      );
    });
    res
      .status(201)
      .json({ webhookUrl: `${origin}/hooks/tradingview/${secret}` });
  });
  app.get("/api/tradingview/drafts", async (_req, res) => {
    const userId = res.locals.session.user_id;
    const drafts = await store.transaction((query) =>
      query(
        'SELECT id,symbol,market,side,order_type AS "orderType",quantity,limit_paise AS "limitPaise",strategy,triggered_at AS "triggeredAt",received_at AS "receivedAt",status FROM tradingview_order_drafts WHERE user_id=$1 ORDER BY received_at DESC LIMIT 100',
        [userId],
      ),
    );
    res.json({ drafts });
  });
  app.post("/api/tradingview/drafts/:id", async (req, res) => {
    const input = actionSchema.parse(req.body),
      userId = res.locals.session.user_id;
    const changed = await store.transaction(async (query) => {
      const rows = await query<{ symbol: string }>(
        "UPDATE tradingview_order_drafts SET status=$1 WHERE id=$2 AND user_id=$3 AND status='pending' RETURNING symbol",
        [input.status, req.params.id, userId],
      );
      if (rows.length) {
        await audit(
          query,
          `TradingView draft ${input.status}: ${rows[0].symbol}.`,
          userId,
        );
      }
      return rows.length;
    });
    if (!changed) {
      fail(409, "This draft is no longer pending.");
    }
    res.json({ ok: true });
  });
}
