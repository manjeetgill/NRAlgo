/** Enrich read-only portfolio snapshots using exact exchange/token quotes, never execution prices. */
import type { PortfolioRow } from "./broker-portfolio-normalizer.js";

type Segment = "nse_cm" | "nse_fo";
type Quote = {
  instrument: string;
  price: number | null;
  observedAt: number | null;
};

export async function enrichPortfolioPositionMarks(
  positions: PortfolioRow[],
  readQuotes: (tokens: string[], segment: Segment) => Promise<Quote[]>,
  now = Date.now(),
): Promise<PortfolioRow[]> {
  const marks = new Map<string, number>();
  for (const segment of ["nse_cm", "nse_fo"] as const) {
    const tokens = [
      ...new Set(
        positions
          .filter(
            (row) =>
              row.quantity !== 0 &&
              row.exchange === segment &&
              /^\d{1,15}$/.test(row.instrumentToken),
          )
          .map((row) => row.instrumentToken),
      ),
    ];
    // Bound automatic quote work. Remaining rows retain the broker's report values.
    for (let offset = 0; offset < Math.min(tokens.length, 200); offset += 50) {
      const batch = tokens.slice(offset, offset + 50);
      try {
        const quotes = await readQuotes(batch, segment);
        const seen = new Set<string>();
        if (
          quotes.some((q) => {
            const invalid =
              !batch.includes(q.instrument) || seen.has(q.instrument);
            seen.add(q.instrument);
            return invalid;
          })
        ) {
          continue;
        }
        for (const quote of quotes) {
          // Closed-market last-traded prices are useful for snapshots; unknown/future dates are not.
          if (
            quote.price !== null &&
            Number.isFinite(quote.price) &&
            quote.price > 0 &&
            quote.observedAt !== null &&
            Number.isFinite(quote.observedAt) &&
            quote.observedAt > 0 &&
            quote.observedAt <= now + 5000 &&
            now - quote.observedAt <= 7 * 24 * 60 * 60 * 1000
          ) {
            marks.set(`${segment}|${quote.instrument}`, quote.price);
          }
        }
      } catch {
        // A quote outage must not hide known position quantities or report values.
      }
    }
  }
  return positions.map((row) => {
    const markPrice =
      row.markPrice ??
      marks.get(`${row.exchange}|${row.instrumentToken}`) ??
      null;
    const calculated =
      markPrice !== null && row.pnlBase !== null && row.pnlPerMark !== null
        ? row.pnlBase + row.pnlPerMark * markPrice
        : null;
    return {
      ...row,
      markPrice,
      pnl:
        row.pnl ??
        (calculated !== null && Number.isFinite(calculated)
          ? calculated
          : null),
    };
  });
}
