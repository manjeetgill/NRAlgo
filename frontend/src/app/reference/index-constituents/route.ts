import {
  INDEX_CONSTITUENT_SNAPSHOT_DATE,
  INDEX_FILES,
  parseConstituents,
  snapshotConstituents,
  type SupportedIndex,
} from "../../../lib/index-constituents";

export const runtime = "nodejs";
type Membership = {
  index: string;
  symbols: string[];
  source: string;
  fetchedAt: string;
};
const cache = new Map<string, { until: number; value: Membership }>();
const pending = new Map<string, Promise<Membership>>();
const failures = new Map<string, number>();

/** Build allowlisted official mirrors; no caller-controlled host or path reaches fetch. */
function sources(index: SupportedIndex) {
  const file = INDEX_FILES[index];
  return [
    {
      url: `https://nsearchives.nseindia.com/content/indices/${file}`,
      referer: "https://www.nseindia.com/",
    },
    {
      url: `https://www.niftyindices.com/IndexConstituent/${file}`,
      referer: "https://www.niftyindices.com/",
    },
  ];
}

/** Read one bounded official CSV response and reject redirects or malformed payloads. */
async function downloadSource(url: string, referer: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "text/csv",
      "User-Agent": "Mozilla/5.0",
      Referer: referer,
    },
  });
  if (!response.ok || !response.body) {
    throw new Error("Constituent source unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > 250000) {
        throw new Error("Constituent source too large");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return parseConstituents(Buffer.concat(chunks).toString("utf8"));
}

/** Try official mirrors, then serve the bundled last-known membership without blocking Kotak. */
async function download(index: SupportedIndex): Promise<Membership> {
  let selectedSource = "";
  let symbols: string[] | null = null;
  for (const source of sources(index)) {
    try {
      symbols = await downloadSource(source.url, source.referer);
      selectedSource = source.url;
      break;
    } catch {
      // Continue to the second allowlisted official host before using the snapshot.
    }
  }
  const value = symbols
    ? {
        index,
        symbols,
        source: selectedSource,
        fetchedAt: new Date().toISOString(),
      }
    : {
        index,
        symbols: snapshotConstituents(index),
        source: "bundled-offline-snapshot",
        fetchedAt: `${INDEX_CONSTITUENT_SNAPSHOT_DATE}T00:00:00.000Z`,
      };
  cache.set(index, { until: Date.now() + 3600000, value });
  return value;
}

/** Serve fixed-index constituents with single-flight caching and failure cooldown; never accept arbitrary URLs. */
export async function GET(request: Request) {
  const index = new URL(request.url).searchParams.get("index") ?? "";
  if (!Object.hasOwn(INDEX_FILES, index)) {
    return Response.json({ error: "Unsupported index" }, { status: 400 });
  }
  const headers = { "Cache-Control": "no-store" };
  const cached = cache.get(index);
  if (cached && cached.until > Date.now()) {
    return Response.json(cached.value, { headers });
  }
  try {
    if ((failures.get(index) ?? 0) > Date.now()) {
      throw new Error("Source cooling down");
    }
    let job = pending.get(index);
    if (!job) {
      job = download(index as SupportedIndex)
        .catch((error) => {
          failures.set(index, Date.now() + 60000);
          throw error;
        })
        .finally(() => pending.delete(index));
      pending.set(index, job);
    }
    return Response.json(await job, { headers });
  } catch {
    return Response.json(
      {
        error:
          "Validated index constituents are unavailable. No unrelated stocks are shown.",
      },
      { status: 503, headers },
    );
  }
}
