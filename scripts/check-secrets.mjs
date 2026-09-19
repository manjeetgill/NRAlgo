/** Dependency-free, redacted secret guard. This is a heuristic, not a security certification.
 * Default: tracked/unignored working files; --staged: exact index; --history: reachable Git blobs.
 * Diagnostics contain only file/revision identifiers and rule names, never matched values.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const rules = [
  [
    "private key",
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  ],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  [
    "JWT credential",
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/,
  ],
  [
    "credential URL",
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?):\/\/[^\s:@/]+:([^\s@/]+)@/gi,
  ],
  [
    "literal credential",
    /(?<![\w-])["']?(?:[A-Z_]*(?:SECRET|PASSWORD|ENCRYPTION_KEY|SERVICE_TOKEN|ACCESS_TOKEN|SETUP_TOKEN)|api[_-]?secret|access[_-]?token|consumer[_-]?key|mpin)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
  ],
  [
    "environment credential",
    /^(?:export\s+)?[A-Z_]*(?:SECRET|PASSWORD|ENCRYPTION_KEY|SERVICE_TOKEN|ACCESS_TOKEN|SETUP_TOKEN)\s*=\s*([^\s#"']{8,})/gm,
  ],
];
const placeholder =
  /^(?:password|runtime-user|migration-user|example|your[-_]|generate[-_]|replace[-_]|test[-_]|fake[-_]|dummy[-_]|synthetic[-_]|\$\{|<)/i;
const forbidden =
  /(?:^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519|postgres-access\.json|credentials)(?:$)|\.(?:pem|key|p12|pfx|db|sqlite3?|dump|backup)$/i;

/** Return categories only; callers cannot accidentally print a secret through this interface. */
export function inspectSecrets(file, content) {
  const findings = new Set();
  if (forbidden.test(file) && !/(?:^|\/)\.env\.example$/.test(file)) {
    findings.add("private runtime file");
  }
  for (const [label, pattern] of rules) {
    for (const match of content.matchAll(
      new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      ),
    )) {
      // Exact deliberately invalid value used to prove production rejects plaintext secrets.
      if (
        file === "scripts/staging-recovery.mjs" &&
        match[1] === "invalid-plaintext-fixture"
      ) {
        continue;
      }
      if (!match[1] || !placeholder.test(match[1])) {
        findings.add(label);
      }
    }
  }
  return [...findings];
}

/** Scan the selected Git snapshot without ever asking Git to print a content-bearing diff. */
function main() {
  const mode = process.argv[2];
  if (mode && !["--staged", "--history"].includes(mode)) {
    throw new Error("Unknown scan mode");
  }
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  let checked = 0,
    failures = 0;
  const check = (file, content, revision = "") => {
    checked++;
    for (const category of inspectSecrets(file, content)) {
      // JSON escaping prevents control characters in untrusted Git paths reaching terminals.
      console.error(`${JSON.stringify(file)} ${revision}: ${category}`);
      failures++;
    }
  };
  if (mode === "--history") {
    const entries = git("rev-list", "--objects", "--all").trim().split("\n");
    const batch = execFileSync("git", ["cat-file", "--batch"], {
      input: entries.map((entry) => entry.split(" ")[0]).join("\n") + "\n",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let offset = 0;
    for (const entry of entries) {
      const end = batch.indexOf(10, offset);
      const [id, type, length] = batch
        .subarray(offset, end)
        .toString()
        .split(" ");
      const size = Number(length);
      if (end < 0 || !Number.isSafeInteger(size) || size < 0) {
        throw new Error("Invalid Git object");
      }
      offset = end + 1;
      if (type === "blob") {
        check(
          entry.slice(41),
          batch.subarray(offset, offset + size).toString("utf8"),
          id.slice(0, 12),
        );
      }
      offset += size + 1;
    }
  } else {
    const files =
      mode === "--staged"
        ? git("ls-files", "-z")
        : git("ls-files", "--cached", "--others", "--exclude-standard", "-z");
    for (const file of files.split("\0").filter(Boolean)) {
      let content;
      try {
        content =
          mode === "--staged"
            ? git("show", `:${file}`)
            : readFileSync(file, "utf8");
      } catch (error) {
        if (mode !== "--staged" && error.code === "ENOENT") {
          continue;
        }
        throw new Error("Cannot read a tracked file; scan incomplete");
      }
      check(file, content);
    }
  }
  console.log(
    `Secret scan: ${checked} files/blobs checked; ${failures} findings. Values are never printed.`,
  );
  if (failures) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch {
    console.error(
      "Secret scan failed; review unavailable Git objects or file permissions.",
    );
    process.exitCode = 1;
  }
}
