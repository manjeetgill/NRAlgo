/** Account-scoped research drafts hold parameters only, never broker prices or execution authorization. */
export type ResearchLeg = {
  stockCode: string;
  side: "buy" | "sell";
  quantity: number;
  expiryDate?: string;
  right?: "call" | "put";
  strikePrice?: number;
};
export type ResearchDefinition = {
  broker: "kotak";
  name: string;
  market: "cash" | "options";
  legs: ResearchLeg[];
  capital: number;
  marginReserve: number;
  entryTime: string;
  exitTime: string;
  stopLoss: number;
  targetProfit: number;
  slippageBps: number;
  feePerOrder: number;
};

export interface ResearchDraft {
  definition: ResearchDefinition;
  savedId: string;
}
const initial: ResearchDefinition = {
  broker: "kotak",
  name: "Cash intraday basket",
  market: "cash",
  legs: [{ stockCode: "RELIANCE", side: "buy", quantity: 1 }],
  capital: 100000,
  marginReserve: 0,
  entryTime: "09:20",
  exitTime: "15:15",
  stopLoss: 2000,
  targetProfit: 4000,
  slippageBps: 5,
  feePerOrder: 20,
};

/** Fresh parameters are editable inputs, not a historical report or account balance. */
export function createResearchDefinition(
  market: "cash" | "options",
): ResearchDefinition {
  return {
    ...structuredClone(initial),
    market,
    name: "",
    legs: market === "options" ? [] : structuredClone(initial.legs),
  };
}
