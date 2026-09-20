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
export function context() {
  return {
    now: 100000,
    reservedPaise: 0,
    outstandingUnits: {},
    ordersLastMinute: 0,
    limits: { ...limits },
    snapshot: {
      capturedAt: 100000,
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
