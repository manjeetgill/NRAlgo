export type Interval = "day" | "week" | "month";

interface Bar {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/** Monday of the ISO week containing this calendar day, as YYYY-MM-DD. */
function isoWeekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const isoDayOfWeek = (date.getUTCDay() + 6) % 7; // Monday=0 .. Sunday=6
  date.setUTCDate(date.getUTCDate() - isoDayOfWeek);
  return date.toISOString().slice(0, 10);
}

/** First day of the calendar month containing this day, as YYYY-MM-DD. */
function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Roll daily bars up into weekly/monthly OHLCV bars. Input must already be day-ordered.
 * A bucket with any missing volume reports null rather than an undercounted sum. */
export function aggregateCandles<T extends Bar>(
  candles: T[],
  interval: Interval,
): Bar[] {
  if (interval === "day") {
    return candles;
  }
  const bucketStart = interval === "week" ? isoWeekStart : monthStart;
  const buckets: Bar[] = [];
  let currentKey = "";
  for (const bar of candles) {
    const key = bucketStart(bar.day);
    if (key !== currentKey) {
      currentKey = key;
      buckets.push({
        day: key,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
      continue;
    }
    const bucket = buckets[buckets.length - 1];
    bucket.high = Math.max(bucket.high, bar.high);
    bucket.low = Math.min(bucket.low, bar.low);
    bucket.close = bar.close;
    bucket.volume =
      bucket.volume === null || bar.volume === null
        ? null
        : bucket.volume + bar.volume;
  }
  return buckets;
}
