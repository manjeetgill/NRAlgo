/** Build exactly the index (or an explicit commit) in a disposable directory.
 * Dependencies are installed from that snapshot's lockfiles, never borrowed from
 * the working tree. No app server, database migration or broker request is run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "nralgo-preflight-"));
const cache = path.join(
  os.tmpdir(),
  `nralgo-build-deps-${process.getuid?.() ?? "local"}`,
);
// Never pass app credentials or Git's index override into npm/build subprocesses.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|HOME|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC|LANG|LC_.*|CI)$/.test(key),
  ),
);
env.NEXT_TELEMETRY_DISABLED = "1";
env.API_URL = "http://api:8000";

/** Forward errors and a nonzero exit to Git, with the failing phase visible. */
function run(command, args, cwd = snapshot) {
  console.log(`Preflight: ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

/** A lockfile-keyed dependency cache avoids repeated downloads for source-only commits. */
function dependencies(folder) {
  const source = path.join(snapshot, folder);
  const files = ["package.json", "package-lock.json"];
  const digest = createHash("sha256").update(
    `${process.version}/${process.platform}/${process.arch}`,
  );
  for (const file of files) {
    digest.update(fs.readFileSync(path.join(source, file)));
  }
  const destination = path.join(cache, digest.digest("hex"));
  const complete = path.join(destination, ".complete");
  if (!fs.existsSync(complete)) {
    fs.mkdirSync(destination, { recursive: true });
    for (const file of files) {
      fs.copyFileSync(path.join(source, file), path.join(destination, file));
    }
    run(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        "--fetch-retries=0",
        "--registry=https://registry.npmjs.org",
        "--cache",
        path.join(os.homedir(), ".npm"),
      ],
      destination,
    );
    fs.writeFileSync(
      complete,
      "Installed from this exact manifest and lockfile.\n",
    );
  }
  fs.symlinkSync(
    path.join(destination, "node_modules"),
    path.join(source, "node_modules"),
    "dir",
  );
}

try {
  const revision = process.argv[2];
  // Scan before installing dependencies or running any code from the candidate snapshot.
  if (!revision) {
    run(
      "node",
      [path.join(root, "scripts/check-secrets.mjs"), "--staged"],
      root,
    );
  }
  if (revision) {
    // Resolve the commit before archiving; options or arbitrary paths are not accepted.
    const commit = execFileSync(
      "git",
      ["rev-parse", "--verify", `${revision}^{commit}`],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const archive = execFileSync("git", ["archive", commit], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", snapshot], { input: archive });
    console.log(`Checking commit ${commit}`);
  } else {
    execFileSync("git", ["checkout-index", "--all", `--prefix=${snapshot}/`], {
      cwd: root,
    });
    console.log("Checking staged files only.");
  }
  // Use today's guard even for an older commit that did not yet contain the scanner.
  const { inspectSecrets } = await import("./check-secrets.mjs");
  for (const entry of fs.readdirSync(snapshot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(snapshot, file).split(path.sep).join("/");
    const findings = inspectSecrets(relative, fs.readFileSync(file, "utf8"));
    if (findings.length) {
      throw new Error(
        `Secret guard: ${JSON.stringify(relative)}: ${findings.join(", ")}`,
      );
    }
  }
  dependencies("");
  dependencies("frontend");
  run("npm", ["run", "lint"]);
  run("npm", ["run", "build:backend"]);
  run("npm", ["--prefix", "frontend", "run", "build"]);
  run("python3", [
    "-c",
    "import ast,pathlib; files=list(pathlib.Path('calculation_engine').glob('*.py'))+list(pathlib.Path('scripts').glob('*.py')); [ast.parse(p.read_text(),filename=str(p)) for p in files]; print(f'Python syntax: {len(files)} modules checked')",
  ]);
  console.log(
    "Preflight passed: lint, backend build, frontend production build and Python syntax.",
  );
} catch (error) {
  console.error(`Preflight failed; commit blocked. ${error.message}`);
  process.exitCode = 1;
} finally {
  // Only remove the directory allocated above, never a checkout or dependency cache.
  fs.rmSync(snapshot, { recursive: true, force: true });
}
