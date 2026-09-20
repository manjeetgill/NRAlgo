export const intent = {
  key: "test-order",
  instrument: "kotak:cash:123",
  side: "buy",
  quantity: 10,
  limitPaise: 1000,
};
export const limits = {
  maxReservedPaise: 100000,
  maxGrossExposurePaise: 200000,
  maxPositionUnits: 100,
  maxDailyLossPaise: 10000,
  maxOrdersPerMinute: 10,
  fundsDriftTolerancePaise: 0,
};
// Wednesday 2026-01-07 10:00 IST: a fixed, deterministic timestamp inside the regular
// NSE session, so risk fixtures are not incidentally gated by market hours.
const FIXTURE_NOW = 1767760200000;
export function context() {
  return {
    now: FIXTURE_NOW,
    reservedPaise: 0,
    outstandingUnits: {},
    ordersLastMinute: 0,
    limits: { ...limits },
    snapshot: {
      capturedAt: FIXTURE_NOW,
      complete: true,
      sessionHealthy: true,
      orders: [],
      positions: {},
      availablePaise: 100000,
      cashBalancePaise: 100000,
      fundsBasis: "cash-ledger",
      grossExposurePaise: 0,
      dailyPnlPaise: 0,
    },
  };
}
export function order(status = "open", filledQuantity = 0) {
  return {
    brokerOrderId: "12345",
    clientOrderKey: intent.key,
    instrument: intent.instrument,
    side: intent.side,
    quantity: intent.quantity,
    status,
    filledQuantity,
    cashDeltaPaise: null,
  };
}
