/** Display-only closing marks. Never persisted as broker quotes or used by execution risk. */
import type { Query } from "./database.js";

type Position = {
  id: string;
  kind: string;
  underlying: string;
  exchange: string;
  expiry: string;
  option_right: string;
  strike: string;
  quantity: number;
  average_price: number | null;
  mark_price: number | null;
  pnl: number | null;
  last_close_day?: string;
  estimated_pnl?: boolean;
};

export function exactOptionExpiry(value: string): string | null {
  let day = value.trim();
  const parts = /^(\d{1,2}) ([A-Za-z]{3}),? (\d{4})$/.exec(day);
  if (parts) {
    const month =
      [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ].indexOf(parts[2].toLowerCase()) + 1;
    if (!month) {
      return null;
    }
    day = `${parts[3]}-${String(month).padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === day
    ? day
    : null;
}

export async function applyPortfolioBhavcopy<T extends Position>(
  query: Query,
  items: T[],
  day: string,
): Promise<T[]> {
  const candidates = items.flatMap((row) => {
    const expiry = exactOptionExpiry(row.expiry);
    const right = (
      { CE: "call", PE: "put", CALL: "call", PUT: "put" } as Record<
        string,
        string
      >
    )[row.option_right.toUpperCase()];
    const strike = Number(row.strike);
    return row.kind === "position" &&
      row.mark_price === null &&
      row.quantity !== 0 &&
      ["nse_fo", "NFO"].includes(row.exchange) &&
      expiry &&
      right &&
      /^[A-Z0-9&_-]{1,40}$/.test(row.underlying) &&
      Number.isFinite(strike) &&
      strike > 0
      ? [
          {
            id: row.id,
            underlying: row.underlying,
            expiry,
            option_right: right,
            strike,
          },
        ]
      : [];
  });
  if (!candidates.length) {
    return items;
  }
  const prices = await query<{ id: string; day: string; close: number }>(
    `
    WITH latest AS (
      SELECT MAX(day) AS day FROM option_eod_candles
      WHERE day <= $2::date AND source LIKE 'nse-fno:%'
    )
    SELECT r.id,c.day::text AS day,c.close
    FROM jsonb_to_recordset($1::jsonb) AS r(id text,underlying text,expiry date,option_right text,strike double precision)
    JOIN option_eod_instruments i ON i.exchange='NSE' AND i.underlying=r.underlying
      AND i.expiry_date=r.expiry AND i.option_right=r.option_right AND i.strike_price=r.strike
    JOIN option_eod_candles c ON c.instrument_id=i.id
    JOIN latest l ON c.day=l.day
    WHERE c.source LIKE 'nse-fno:%' AND c.close>0 AND c.day<=i.expiry_date
  `,
    [JSON.stringify(candidates), day],
  );
  const byId = new Map<string, typeof prices>();
  for (const price of prices) {
    byId.set(price.id, [...(byId.get(price.id) ?? []), price]);
  }
  return items.map((row) => {
    const matched = byId.get(row.id);
    if (
      matched?.length !== 1 ||
      !Number.isFinite(matched[0].close) ||
      matched[0].close <= 0
    ) {
      return row;
    }
    const mark = matched[0];
    const estimate =
      row.average_price === null
        ? null
        : (mark.close - row.average_price) * row.quantity;
    const estimated =
      row.pnl === null && estimate !== null && Number.isFinite(estimate);
    return {
      ...row,
      mark_price: mark.close,
      last_close_day: mark.day,
      pnl: estimated ? estimate : row.pnl,
      estimated_pnl: estimated,
    };
  });
}
