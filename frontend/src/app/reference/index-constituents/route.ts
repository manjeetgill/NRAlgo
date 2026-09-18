import {
  INDEX_FILES,
  parseConstituents,
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

async function download(index: keyof typeof INDEX_FILES): Promise<Membership> {
  const source = `https://www.niftyindices.com/IndexConstituent/${INDEX_FILES[index]}`;
  const response = await fetch(source, {
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
    redirect: "error",
    // The official download service can stall requests without these headers.
    headers: {
      Accept: "text/csv",
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.niftyindices.com/",
    },
  });
  if (!response.ok || !response.body)
    throw new Error("Constituent source unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 250000) throw new Error("Constituent source too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const value = {
    index,
    symbols: parseConstituents(Buffer.concat(chunks).toString("utf8")),
    source,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(index, { until: Date.now() + 3600000, value });
  return value;
}

export async function GET(request: Request) {
  const index = new URL(request.url).searchParams.get("index") ?? "";
  if (!Object.hasOwn(INDEX_FILES, index)) {
    return Response.json({ error: "Unsupported index" }, { status: 400 });
  }
  const headers = { "Cache-Control": "no-store" };
  const cached = cache.get(index);
  if (cached && cached.until > Date.now())
    return Response.json(cached.value, { headers });
  try {
    if ((failures.get(index) ?? 0) > Date.now())
      throw new Error("Source cooling down");
    let job = pending.get(index);
    if (!job) {
      job = download(index as keyof typeof INDEX_FILES)
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
          "Official index constituents are temporarily unavailable. No unrelated stocks are shown.",
      },
      { status: 503, headers },
    );
  }
}
