"use client";

/** TradingView signals are durable user drafts, never OMS records or broker instructions. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { requestApiJson } from "@/lib/api";

export type TradingViewDraft = {
  id: string;
  symbol: string;
  market: "cash" | "options";
  side: "buy" | "sell";
  orderType: "market" | "limit";
  quantity: number;
  limitPaise: number | null;
  strategy: string;
  triggeredAt: string;
  receivedAt: string;
  status: "pending" | "accepted" | "dismissed" | "expired";
};

const tradingViewMessage = `{
  "alertId": "ema-cross-{{ticker}}-{{timenow}}",
  "symbol": "{{exchange}}:{{ticker}}",
  "market": "CASH",
  "side": "BUY",
  "orderType": "LIMIT",
  "quantity": 1,
  "limitPrice": {{close}},
  "strategy": "EMA crossover",
  "triggeredAt": "{{timenow}}"
}`;

const money = (paise: number) =>
  (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR" });

/** Configure a one-time webhook URL and acknowledge received trade drafts without broker access. */
export function TradingViewDrafts({
  csrf,
  onAccept,
}: {
  csrf: string;
  onAccept: (draft: TradingViewDraft) => void;
}) {
  const toast = useToast();
  const seen = useRef(new Set<string>());
  const [drafts, setDrafts] = useState<TradingViewDraft[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await requestApiJson("/tradingview/drafts");
    const received = result.drafts as TradingViewDraft[];
    const newPending = received.filter(
      (draft) => draft.status === "pending" && !seen.current.has(draft.id),
    );
    received.forEach((draft) => seen.current.add(draft.id));
    setDrafts(received);
    setError("");
    if (newPending.length) {
      toast({
        tone: "info",
        title: `${newPending.length} TradingView order draft${newPending.length === 1 ? "" : "s"} received`,
        description:
          "Review and accept or dismiss; no order has been submitted.",
      });
    }
  }, [toast]);
  useEffect(() => {
    const refresh = () =>
      void load().catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "TradingView drafts are unavailable.",
        ),
      );
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function generateWebhook() {
    setBusy(true);
    setError("");
    try {
      const result = await requestApiJson(
        "/tradingview/webhook",
        "POST",
        {},
        csrf,
      );
      setWebhookUrl(result.webhookUrl);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create webhook URL.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function updateDraft(
    draft: TradingViewDraft,
    status: "accepted" | "dismissed",
  ) {
    setBusy(true);
    setError("");
    try {
      await requestApiJson(
        `/tradingview/drafts/${draft.id}`,
        "POST",
        { status },
        csrf,
      );
      if (status === "accepted") {
        onAccept(draft);
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update draft.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>TradingView order drafts</CardTitle>
          <CardDescription>
            Alerts create unsubmitted drafts only. Receiving or accepting a
            draft never contacts a broker.
          </CardDescription>
        </div>
        <Button variant="secondary" disabled={busy} onClick={() => void load()}>
          Refresh alerts
        </Button>
      </CardHeader>
      <div className="screen-stack">
        <Button disabled={busy} onClick={() => void generateWebhook()}>
          Generate TradingView webhook URL
        </Button>
        {webhookUrl && (
          <div>
            <p>
              Copy this once into TradingView&apos;s Webhook URL field.
              Generating another URL revokes this one.
            </p>
            <input
              aria-label="TradingView webhook URL"
              readOnly
              value={webhookUrl}
            />
            <p>
              Use this JSON in TradingView&apos;s alert Message field. Change
              the side, quantity and strategy name for the alert you create.
            </p>
            <pre>{tradingViewMessage}</pre>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {drafts.length === 0 && <p>No TradingView order drafts received.</p>}
        {drafts.map((draft) => (
          <article key={draft.id}>
            <p>
              <strong>{draft.symbol}</strong> · {draft.side.toUpperCase()}{" "}
              {draft.quantity} · {draft.orderType.toUpperCase()}
              {draft.limitPaise ? ` at ${money(draft.limitPaise)}` : ""}
              {draft.strategy ? ` · ${draft.strategy}` : ""}
            </p>
            <p>
              Alert: {new Date(draft.triggeredAt).toLocaleString()} · received{" "}
              {new Date(draft.receivedAt).toLocaleString()}
            </p>
            <Badge
              tone={
                draft.status === "accepted"
                  ? "success"
                  : draft.status === "dismissed"
                    ? "neutral"
                    : "warning"
              }
            >
              {draft.status}
            </Badge>
            {draft.status === "pending" && (
              <p>
                <Button
                  disabled={busy}
                  onClick={() => void updateDraft(draft, "accepted")}
                >
                  Accept draft
                </Button>{" "}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void updateDraft(draft, "dismissed")}
                >
                  Dismiss
                </Button>
              </p>
            )}
          </article>
        ))}
      </div>
    </Card>
  );
}
