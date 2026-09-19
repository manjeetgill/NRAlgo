/**
 * Durable, owner-scoped option-chain snapshots.
 *
 * Only normalized responses produced by a connected market-data adapter are
 * persisted. Historical screens may replay those observations, but this module
 * never manufactures a premium, derives an option price from the underlying or
 * treats a stored observation as executable.
 */
import { z } from "zod";
import type { Store } from "./database.js";
import {
  readOptionEodChain,
  readOptionEodExpiries,
} from "./stored-market-data.js";

const storedChainSchema = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())).max(50),
    expiries: z.array(z.iso.date()).max(200),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    source: z.string().min(1).max(40),
    receivedAt: z.number().int().nonnegative(),
    warning: z.string().max(500).optional(),
  })
  .passthrough();

export type StoredOptionChain = z.infer<typeof storedChainSchema>;

/** End an ISO exchange day at 23:59:59.999 IST for an inclusive replay lookup. */
function replayCutoff(asOf?: string) {
  return asOf ? Date.parse(`${asOf}T23:59:59.999+05:30`) : Date.now();
}

/** Persist one quoted page and retain a bounded audit trail for the same contract page. */
export async function saveOptionChainSnapshot(
  store: Store,
  input: {
    userId: string;
    provider: string;
    underlying: string;
    expiryDate: string;
    offset: number;
    observedAt: number;
    chain: unknown;
  },
) {
  const chain = storedChainSchema.parse(input.chain);
  await store.transaction(async (query) => {
    await query(
      "INSERT INTO option_chain_snapshots(user_id,provider,underlying,expiry_date,page_offset,observed_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,provider,underlying,expiry_date,page_offset,observed_at) DO UPDATE SET payload=EXCLUDED.payload",
      [
        input.userId,
        input.provider,
        input.underlying,
        input.expiryDate,
        input.offset,
        input.observedAt,
        JSON.stringify(chain),
      ],
    );
    await query(
      "DELETE FROM option_chain_snapshots WHERE user_id=$1 AND provider=$2 AND underlying=$3 AND expiry_date=$4 AND page_offset=$5 AND observed_at NOT IN (SELECT observed_at FROM option_chain_snapshots WHERE user_id=$1 AND provider=$2 AND underlying=$3 AND expiry_date=$4 AND page_offset=$5 ORDER BY observed_at DESC LIMIT 40)",
      [
        input.userId,
        input.provider,
        input.underlying,
        input.expiryDate,
        input.offset,
      ],
    );
  });
}

/** List only underlyings for which this owner has a genuine stored broker snapshot. */
export async function searchStoredOptionUnderlyings(
  store: Store,
  userId: string,
  queryText: string,
  asOf?: string,
) {
  const pattern = `%${queryText.replaceAll("%", "").replaceAll("_", "")}%`;
  const rows = await store.transaction((query) =>
    query<{ underlying: string }>(
      `SELECT underlying FROM (
         SELECT DISTINCT underlying FROM option_chain_snapshots
         WHERE user_id=$1 AND underlying ILIKE $2 AND observed_at<=$3
         UNION
         SELECT DISTINCT symbol AS underlying FROM eod_instruments
         WHERE symbol ILIKE $2
         UNION
         SELECT DISTINCT i.underlying FROM option_eod_instruments i
         JOIN option_eod_candles c ON c.instrument_id=i.id
         WHERE i.underlying ILIKE $2 AND c.day<=to_timestamp($3/1000.0)::date
       ) available ORDER BY underlying LIMIT 50`,
      [userId, pattern, replayCutoff(asOf)],
    ),
  );
  return rows.map((row) => row.underlying);
}

/** Read expiry metadata and one exact stored page as it existed at the requested replay cutoff. */
export async function readOptionChainSnapshot(
  store: Store,
  input: {
    userId: string;
    provider?: string;
    underlying: string;
    expiryDate?: string;
    offset: number;
    asOf?: string;
    closingOnly?: boolean;
  },
) {
  // The chain screen's off-market view must be a genuine EOD close, not an
  // arbitrary intraday broker observation or an old expiry from another day.
  if (input.closingOnly) {
    const now = new Date(Date.now() + 19800000);
    if (now.getUTCHours() * 60 + now.getUTCMinutes() < 930) {
      now.setUTCDate(now.getUTCDate() - 1);
    }
    const cutoffDay = input.asOf ?? now.toISOString().slice(0, 10);
    if (input.expiryDate) {
      return readOptionEodChain(store, {
        ...input,
        expiryDate: input.expiryDate,
        asOf: cutoffDay,
      });
    }
    const metadata = await readOptionEodExpiries(store, {
      underlying: input.underlying,
      asOf: cutoffDay,
    });
    if (!metadata) {
      return null;
    }
    const observedAt = Date.parse(`${metadata.day}T15:30:00+05:30`);
    return {
      items: [],
      expiries: metadata.expiries,
      total: 0,
      nextOffset: null,
      source: "NSE F&O bhavcopy",
      dataMode: "historical" as const,
      receivedAt: observedAt,
      observedAt,
      sessionDay: metadata.day,
    };
  }
  const cutoff = replayCutoff(input.asOf);
  const stored = await store.transaction(async (query) => {
    const expiries = await query<{
      expiry_date: string;
      observed_at: number;
      provider: string;
    }>(
      `SELECT expiry_date::text,MAX(observed_at) AS observed_at,MAX(provider) AS provider
       FROM option_chain_snapshots
       WHERE user_id=$1 AND underlying=$2 AND observed_at<=$3${input.provider ? " AND provider=$4" : ""}
       GROUP BY expiry_date ORDER BY expiry_date`,
      input.provider
        ? [input.userId, input.underlying, cutoff, input.provider]
        : [input.userId, input.underlying, cutoff],
    );
    const latestObservation = Math.max(
      0,
      ...expiries.map((row) => Number(row.observed_at)),
    );
    if (!input.expiryDate) {
      return expiries.length
        ? {
            items: [],
            expiries: expiries.map((row) => row.expiry_date),
            total: 0,
            nextOffset: null,
            source: expiries[0]?.provider ?? "stored-database",
            receivedAt: latestObservation,
            dataMode: "historical" as const,
            observedAt: latestObservation,
          }
        : null;
    }
    const params: (string | number)[] = [
      input.userId,
      input.underlying,
      input.expiryDate,
      input.offset,
      cutoff,
    ];
    let [row] = await query<{
      payload: string;
      observed_at: number;
      page_offset: number;
    }>(
      `SELECT payload,observed_at,page_offset FROM option_chain_snapshots
       WHERE user_id=$1 AND underlying=$2 AND expiry_date=$3 AND page_offset=$4 AND observed_at<=$5${input.provider ? " AND provider=$6" : ""}
       ORDER BY observed_at DESC LIMIT 1`,
      input.provider ? [...params, input.provider] : params,
    );
    // A historical snapshot may have been captured around ATM rather than at
    // offset zero. Falling back to the newest genuine page keeps replay useful
    // without pretending that unobserved strikes existed in storage.
    if (!row) {
      const fallbackParams: (string | number)[] = [
        input.userId,
        input.underlying,
        input.expiryDate,
        cutoff,
      ];
      [row] = await query<{
        payload: string;
        observed_at: number;
        page_offset: number;
      }>(
        `SELECT payload,observed_at,page_offset FROM option_chain_snapshots
         WHERE user_id=$1 AND underlying=$2 AND expiry_date=$3 AND observed_at<=$4${input.provider ? " AND provider=$5" : ""}
         ORDER BY observed_at DESC LIMIT 1`,
        input.provider ? [...fallbackParams, input.provider] : fallbackParams,
      );
    }
    if (!row) {
      return null;
    }
    return {
      ...storedChainSchema.parse(JSON.parse(row.payload)),
      dataMode: "historical" as const,
      observedAt: Number(row.observed_at),
      pageOffset: Number(row.page_offset),
    };
  });
  if (input.expiryDate) {
    return (
      stored ??
      readOptionEodChain(store, {
        underlying: input.underlying,
        expiryDate: input.expiryDate,
        offset: input.offset,
        asOf: input.asOf,
      })
    );
  }
  const eod = await readOptionEodExpiries(store, {
    underlying: input.underlying,
    asOf: input.asOf,
  });
  if (!eod) {
    return stored;
  }
  const observedAt = Date.parse(`${eod.day}T15:30:00+05:30`);
  const expiries = [
    ...new Set([...(stored?.expiries ?? []), ...eod.expiries]),
  ].sort();
  return {
    ...(stored ?? {
      items: [],
      total: 0,
      nextOffset: null,
      dataMode: "historical" as const,
    }),
    expiries,
    source: stored?.source ?? "NSE F&O bhavcopy",
    receivedAt: Math.max(stored?.receivedAt ?? 0, observedAt),
    observedAt: Math.max(stored?.observedAt ?? 0, observedAt),
    sessionDay: eod.day,
  };
}

/** Display-data schedule only, never authorization to execute orders.
 * 2026 closures: NSE/CMTR/71775 and NSE/CMTR/72260. Operators must maintain
 * closures and special sessions as new exchange notices are published.
 */
const closures2026 = new Set([
  "2026-01-15",
  "2026-01-26",
  "2026-03-03",
  "2026-03-26",
  "2026-03-31",
  "2026-04-03",
  "2026-04-14",
  "2026-05-01",
  "2026-05-28",
  "2026-06-26",
  "2026-09-14",
  "2026-10-02",
  "2026-10-20",
  "2026-11-10",
  "2026-11-24",
  "2026-12-25",
]);
export function optionChainSessionOpen(
  now: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const ist = new Date(now + 19800000);
  const day = ist.toISOString().slice(0, 10);
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Explicit date=HH:MM-HH:MM overrides support notified weekend/Muhurat sessions.
  const special = (env.NSE_SPECIAL_SESSIONS || "")
    .split(",")
    .find((value) => value.trim().startsWith(`${day}=`));
  if (special) {
    const match = special
      .trim()
      .match(/^\d{4}-\d{2}-\d{2}=(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!match) {
      return false;
    }
    const [h1, m1, h2, m2] = match.slice(1).map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) {
      return false;
    }
    return minute >= h1 * 60 + m1 && minute < h2 * 60 + m2;
  }
  if (
    closures2026.has(day) ||
    (env.NSE_CLOSED_DATES || "")
      .split(",")
      .map((value) => value.trim())
      .includes(day)
  ) {
    return false;
  }
  return (
    ist.getUTCDay() > 0 && ist.getUTCDay() < 6 && minute >= 555 && minute < 930
  );
}
