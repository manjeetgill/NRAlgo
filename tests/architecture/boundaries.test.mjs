/** Fast structural checks prevent large-shell regressions and undeclared production dependencies. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import ts from "typescript";

/** Enumerate owned TypeScript sources only; never inspect runtime databases, credentials or dependencies. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : /\.tsx?$/.test(file)
        ? [file]
        : [];
  });
}
/** Parse static/dynamic module references using the compiler, not substring guesses about unused files. */
function imports(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const values = [];
  /** Import declarations and literal dynamic imports form the bundled source graph. */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      values.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      values.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return values;
}

test("Next route is composition only and each destination owns a screen file", () => {
  const page = readFileSync("frontend/src/app/page.tsx", "utf8");
  assert.ok(page.split("\n").length < 30);
  assert.doesNotMatch(page, /useEffect|requestApiJson|<table|<form/);
  for (const screen of [
    "account/account",
    "activity/activity",
    "auth/auth",
    "brokers/brokers",
    "learning/learning",
    "live-trading/live-trading",
    "orders/orders",
    "overview/overview",
    "paper-trading/paper-trading",
    "strategies/strategies",
    "strategy-lab/strategy-lab",
    "strategy-library/strategy-library",
    "backtest-studio/backtest-studio",
    "spread-builder/spread-builder",
    "option-chain/option-chain",
  ]) {
    assert.ok(existsSync(`frontend/src/features/${screen}-screen.tsx`), screen);
  }
});

test("frontend imports never cross into backend and package imports are declared locally", () => {
  const manifest = JSON.parse(readFileSync("frontend/package.json", "utf8"));
  const declared = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.devDependencies),
  ]);
  for (const file of sourceFiles("frontend/src")) {
    for (const name of imports(file)) {
      if (name.startsWith("node:")) {
        continue;
      }
      if (name.startsWith(".") || name.startsWith("@/")) {
        const target = name.startsWith("@/")
          ? resolve("frontend/src", name.slice(2))
          : resolve(dirname(file), name);
        assert.ok(
          !relative(resolve("frontend/src"), target).startsWith(".."),
          `${file}: ${name} crosses the browser/server boundary`,
        );
      } else {
        const packageName = name.startsWith("@")
          ? name.split("/").slice(0, 2).join("/")
          : name.split("/")[0];
        assert.ok(
          declared.has(packageName),
          `${file}: ${packageName} is not declared in frontend/package.json`,
        );
      }
    }
  }
});

test("frontend package and lockfile agree on production dependencies", () => {
  const manifest = JSON.parse(readFileSync("frontend/package.json", "utf8"));
  const lock = JSON.parse(readFileSync("frontend/package-lock.json", "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  for (const name of Object.keys(manifest.dependencies)) {
    assert.ok(lock.packages[`node_modules/${name}`], `Missing locked ${name}`);
  }
});

test("every owned application source has a documented responsibility", () => {
  const inventory = readFileSync("docs/repository-map.md", "utf8");
  for (const file of [
    ...sourceFiles("backend"),
    ...sourceFiles("frontend/src"),
  ]) {
    const path = relative(process.cwd(), file).replaceAll("\\", "/");
    assert.ok(
      inventory.includes(`[${path}]`),
      `Document ${path} in the file map`,
    );
  }
});

test("CI executes the complete local quality gate and runtime images exclude tests", () => {
  assert.match(
    readFileSync(".github/workflows/checks.yml", "utf8"),
    /npm run check/,
  );
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  for (const check of [
    "npm run lint",
    "npm test",
    "frontend run typecheck",
    "frontend test",
    "test:architecture",
  ]) {
    assert.ok(scripts.check.includes(check), check);
  }
  assert.match(readFileSync(".dockerignore", "utf8"), /^tests$/m);
  assert.equal(existsSync("backend/worker.ts"), false);
  assert.equal(existsSync("backend/simulator.ts"), false);
  assert.equal("worker" in scripts, false);
  assert.doesNotMatch(
    readFileSync("frontend/src/components/kotak-account-reports.tsx", "utf8"),
    /autoRefresh|setInterval\([^\n]*refresh\(/,
    "Broker account records must not reintroduce automatic report polling",
  );
});
