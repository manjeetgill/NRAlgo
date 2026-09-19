export type MarketDataBroker = "kotak";

export interface OptionContract {
  expiryDate: string;
  right: "call" | "put";
  strikePrice: number;
  lotSize: number;
}

export interface InstrumentSelection {
  instrument: string;
  option?: OptionContract;
  masterToken?: string;
}

export interface TopOfBookQuote {
  instrument: string;
  bid: number;
  ask: number;
  observedAt: number;
  receivedAt: number;
}

export const tradingDay = (now: number) =>
  new Date(now + 19800000).toISOString().slice(0, 10);

/** Conservative weekday session check; exchange holidays are handled by data availability. */
export function regularMarketSessionOpen(now: number) {
  const date = new Date(now + 19800000);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (
    date.getUTCDay() > 0 &&
    date.getUTCDay() < 6 &&
    minute >= 555 &&
    minute < 930
  );
}
