"use client";
/** Cross-screen handoff state (research/spread/template drafts) shared by Option Chain, Spread
 * Builder, Strategy Lab and Backtest Studio. Split out of WorkspaceShell so navigation stays a
 * pure routing concern and this file owns only the draft business rules. */
import { useCallback, useState } from "react";
import { useConfirm } from "@/components/ui/confirm";
import type { TemplateId } from "@/features/strategy-library/strategy-templates";
import {
  createResearchDefinition,
  type ResearchDraft,
} from "@/features/research/research-draft";
import type { ChainContract } from "@/components/live-option-chain";
import type { WorkspacePage } from "./workspace-types";

export interface SpreadContext {
  underlying: string;
  expiry?: string;
  day?: string;
  spot?: number;
}

export function useWorkspaceDrafts(
  onNavigate: (
    destination: WorkspacePage,
    afterNavigate?: () => void,
  ) => boolean,
) {
  const confirm = useConfirm();
  const [researchStrategyId, setResearchStrategyId] = useState("");
  const [templateId, setTemplateId] = useState<TemplateId>("ema");
  const [spreadDraft, setSpreadDraft] = useState<ResearchDraft>();
  const [spreadContext, setSpreadContext] = useState<SpreadContext>();

  /** Call once navigation away from a page has committed; clears drafts that don't survive it. */
  const onNavigated = useCallback((from: WorkspacePage, to: WorkspacePage) => {
    if (from === "Spread builder" && to !== "Spread builder") {
      setSpreadDraft(undefined);
      setSpreadContext(undefined);
    }
  }, []);

  const onOpenStrategy = useCallback(
    (id: string, market: "cash" | "options") => {
      onNavigate(
        market === "options" ? "Spread builder" : "Strategy lab",
        () => {
          setResearchStrategyId(id);
          if (market === "options") {
            setSpreadDraft(undefined);
            setSpreadContext(undefined);
          }
        },
      );
    },
    [onNavigate],
  );

  /** Add exact master metadata to an account-scoped, in-memory draft; never create orders. */
  const onAddSpreadLeg = useCallback(
    (contract: ChainContract, side: "buy" | "sell") => {
      const spreadLegs = spreadDraft?.definition.legs ?? [];
      if (!contract.option) {
        return "Select a listed option contract.";
      }
      if (!Number.isSafeInteger(contract.lotSize) || contract.lotSize < 1) {
        return "This legacy archive does not include a verified lot size. Add the leg in the builder and enter units manually.";
      }
      if (spreadLegs.length >= 4) {
        return "A spread supports at most four legs. Remove one in the builder first.";
      }
      const option = contract.option;
      if (
        spreadLegs.some(
          (leg) =>
            leg.stockCode !== contract.symbol ||
            leg.expiryDate !== option.expiryDate,
        )
      ) {
        return "Start a new spread before adding a different underlying or expiry.";
      }
      if (
        spreadLegs.some(
          (leg) =>
            leg.stockCode === contract.symbol &&
            leg.expiryDate === option.expiryDate &&
            leg.right === option.right &&
            leg.strikePrice === option.strikePrice,
        )
      ) {
        return "This contract is already in your draft. Edit its units in the builder.";
      }
      setSpreadDraft({
        savedId: "",
        definition: {
          ...(spreadDraft?.definition ?? createResearchDefinition("options")),
          legs: [
            ...spreadLegs,
            {
              stockCode: contract.symbol,
              expiryDate: option.expiryDate,
              right: option.right,
              strikePrice: option.strikePrice,
              side,
              quantity: contract.lotSize,
            },
          ],
        },
        marketReferences: [
          ...(spreadDraft?.marketReferences ?? []),
          ...(typeof contract.price === "number" && contract.price >= 0
            ? [
                {
                  stockCode: contract.symbol,
                  expiryDate: option.expiryDate,
                  right: option.right,
                  strikePrice: option.strikePrice,
                  price: contract.price,
                  observedAt: contract.tickAt,
                },
              ]
            : []),
        ],
      });
      setSpreadContext({
        underlying: contract.symbol,
        expiry: option.expiryDate,
      });
      setResearchStrategyId("");
      onNavigate("Spread builder");
      return "";
    },
    [spreadDraft, onNavigate],
  );

  const onConfigureTemplate = useCallback(
    (id: TemplateId) => {
      onNavigate("Backtest studio", () => setTemplateId(id));
    },
    [onNavigate],
  );

  /** Selecting a chain contract for the builder may discard a draft for a different underlying/expiry. */
  const onOpenBuilder = useCallback(
    async (selection: SpreadContext) => {
      if (
        spreadDraft?.definition.legs.some(
          (leg) =>
            leg.stockCode !== selection.underlying ||
            (selection.expiry && leg.expiryDate !== selection.expiry),
        )
      ) {
        const proceed = await confirm({
          title: "Start a new spread?",
          description:
            "Starting a new spread with this underlying and expiry will clear the existing chain-selected draft.",
          confirmLabel: "Start new spread",
          tone: "danger",
        });
        if (!proceed) {
          return;
        }
        setSpreadDraft(undefined);
      }
      setSpreadContext(selection);
      onNavigate("Spread builder");
    },
    [spreadDraft, onNavigate, confirm],
  );

  return {
    researchStrategyId,
    templateId,
    spreadDraft,
    spreadContext,
    onNavigated,
    onOpenStrategy,
    onAddSpreadLeg,
    onConfigureTemplate,
    onOpenBuilder,
  };
}
