/** Download a public Kaggle archive and provenance; never executes or extracts dataset content. */
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const ref = process.argv[2];
if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(ref || "")) {
  throw new Error("Usage: node scripts/download-kaggle.mjs owner/dataset");
}
const metadataResponse = await fetch(
  `https://www.kaggle.com/api/v1/datasets/view/${ref}`,
  { signal: AbortSignal.timeout(30000) },
);
if (!metadataResponse.ok) {
  throw new Error(`Kaggle metadata HTTP ${metadataResponse.status}`);
}
const metadata = await metadataResponse.json();
const version = metadata.currentVersionNumber;
if (!Number.isSafeInteger(version) || version < 1) {
  throw new Error("Invalid Kaggle version");
}
const target = resolve(
  ".runtime/kaggle",
  ref.replace("/", "--"),
  `v${version}`,
);
await mkdir(target, { recursive: true });
const archive = resolve(target, "dataset.zip");
const temporary = resolve(target, "dataset.zip.part");
const response = await fetch(
  `https://www.kaggle.com/api/v1/datasets/download/${ref}?datasetVersionNumber=${version}`,
  { signal: AbortSignal.timeout(300000) },
);
if (!response.ok || !response.body) {
  throw new Error(
    `Kaggle download HTTP ${response.status}; sign-in may be required. Do not paste tokens into chat.`,
  );
}
const hash = createHash("sha256");
let bytes = 0;
let prefix = Buffer.alloc(0);
const inspect = new Transform({
  transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > 200 * 1024 * 1024) {
      done(new Error("Archive exceeds 200 MiB safety limit"));
      return;
    }
    if (prefix.length < 4) {
      prefix = Buffer.concat([prefix, chunk]).subarray(0, 4);
    }
    hash.update(chunk);
    done(null, chunk);
  },
});
try {
  await pipeline(
    Readable.fromWeb(response.body),
    inspect,
    createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
  );
  if (!prefix.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error(
      "Response is not a ZIP archive; possible sign-in or access challenge",
    );
  }
  // No overwrite of an existing downloaded version.
  const { link } = await import("node:fs/promises");
  await link(temporary, archive);
  await unlink(temporary);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}
const provenance = {
  dataset: ref,
  version,
  title: metadata.title,
  lastUpdated: metadata.lastUpdated,
  license: metadata.licenseName,
  description: metadata.description,
  url: `https://www.kaggle.com/datasets/${ref}`,
  downloadedAt: new Date().toISOString(),
  bytes,
  sha256: hash.digest("hex"),
  imported: false,
};
await writeFile(
  resolve(target, "provenance.json.tmp"),
  JSON.stringify(provenance, null, 2),
  { mode: 0o600 },
);
await rename(
  resolve(target, "provenance.json.tmp"),
  resolve(target, "provenance.json"),
);
console.log(
  JSON.stringify({
    archive,
    bytes,
    version,
    license: metadata.licenseName,
    lastUpdated: metadata.lastUpdated,
    imported: false,
  }),
);
