export type IntradaySpanMinutes = 1 | 5 | 15 | 30 | 60;

/** Conservative weekday session check; mirrors the backend's regularMarketSessionOpen
 * exactly (9:15–15:30 IST, Mon–Fri) so the UI never offers live mode the server would
 * refuse. Exchange holidays are handled by data availability, not this clock check. */
export function regularMarketSessionOpen(now: number): boolean {
  const date = new Date(now + 19800000);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (
    date.getUTCDay() > 0 &&
    date.getUTCDay() < 6 &&
    minute >= 555 &&
    minute < 930
  );
}

export interface PriceTick {
  price: number;
  at: number;
}

interface Bar {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  timestamp: number;
}

/** Roll broker last-price ticks up into fixed-span OHLC bars for the running session.
 * Volume is always null: the touchline feed reports a cumulative day total, not the
 * per-trade size a bar would need, so a summed bucket total would be fabricated. */
export function bucketTicksToBars(
  ticks: PriceTick[],
  spanMinutes: IntradaySpanMinutes,
): Bar[] {
  const spanMs = spanMinutes * 60000;
  const bars: Bar[] = [];
  let bucketStart = -1;
  const ordered = [...ticks].sort((a, b) => a.at - b.at);
  for (const tick of ordered) {
    const start = Math.floor(tick.at / spanMs) * spanMs;
    if (start !== bucketStart) {
      bucketStart = start;
      bars.push({
        day: new Date(start).toISOString(),
        timestamp: start,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: null,
      });
      continue;
    }
    const bar = bars[bars.length - 1];
    bar.high = Math.max(bar.high, tick.price);
    bar.low = Math.min(bar.low, tick.price);
    bar.close = tick.price;
  }
  return bars;
}
