/** Real browser + isolated PostgreSQL, fake broker only. Never touches the user's app data. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TOTP } from "otpauth";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { fakeInstrumentCatalog } from "../fixtures/instruments.mjs";
import {
  fakeKotakData,
  fakeKotakLogin,
  fakeIndexFeedSocket,
} from "../fixtures/kotak-data.mjs";

const realNow = Date.now,
  fixedNow = Date.parse("2026-09-18T05:00:00Z");
Date.now = () => fixedNow;
const store = await createPostgresTestStore();
await runDatabaseMigrations(store, {});
const calls = [],
  frontendUrl = "http://127.0.0.1:3010";
const app = createApiApplication(
  store,
  {
    APP_ORIGIN: frontendUrl,
    BROKER_ENCRYPTION_KEY: "ab".repeat(32),
    PAPER_TRADING_ENABLED: "true",
  },
  fakeKotakData(calls, fakeIndexFeedSocket),
  fakeInstrumentCatalog(),
);
const api = app.listen(0, "127.0.0.1");
await new Promise((resolve) => api.once("listening", resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;
let frontend, browser;
try {
  frontend = spawn(
    process.execPath,
    [
      "frontend/node_modules/next/dist/bin/next",
      "start",
      "frontend",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3010",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; ; i++) {
    try {
      if (
        (await fetch(frontendUrl, { signal: AbortSignal.timeout(1000) })).ok
      ) {
        break;
      }
    } catch {}
    assert.ok(i < 40, "Frontend failed to start");
    await delay(500);
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "darwin" ? { channel: "chrome" } : {}),
  });
  const context = await browser.newContext();
  await context.route("**/reference/index-constituents?index=*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ index: "NIFTY", symbols: ["TEST"] }),
    }),
  );
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({ url: apiUrl + url.pathname + url.search }),
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript((now) => {
    Date.now = () => now;
  }, fixedNow);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const document = await page.goto(frontendUrl);
  const csp = document.headers()["content-security-policy"];
  assert.match(csp, /'nonce-/);
  assert.ok(!csp.includes("'unsafe-eval'"));
  await page.getByLabel("Username", { exact: true }).fill("kotak-browser");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-password-long");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Broker connections", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect broker", exact: true })
    .click();
  const inputs = {
    "API access token": "accessToken",
    "Mobile (+91…)": "mobileNumber",
    "Client code (UCC)": "ucc",
    "Authenticator TOTP": "totp",
    MPIN: "mpin",
  };
  for (const [label, key] of Object.entries(inputs)) {
    await page.getByLabel(label, { exact: true }).fill(fakeKotakLogin[key]);
  }
  await page
    .getByRole("button", { name: "Connect Kotak Neo", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Connected$/ })
    .waitFor();
  await page
    .getByRole("button", { name: "View broker portfolio", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh broker portfolio", exact: true })
    .click();
  await page
    .getByRole("cell", { name: "REAL-KOTAK", exact: true })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Paper trading", exact: true })
    .click();
  await page.getByRole("button", { name: "New order", exact: true }).click();
  const symbols = page.getByLabel("Kotak NSE cash token (pSymbol)", {
    exact: true,
  });
  await symbols
    .locator("option", { hasText: "TEST · TEST-EQ · token 123" })
    .waitFor({ state: "attached" });
  await symbols.selectOption("kotak:cash:123");
  await page.getByLabel("Paper limit (₹)", { exact: true }).fill("120");
  await page
    .getByRole("button", { name: "Review paper order", exact: true })
    .click();
  await page
    .getByLabel("I have reviewed the contract, units and limit.")
    .check();
  await page
    .getByRole("button", { name: "Confirm paper order", exact: true })
    .click();
  await page.getByRole("cell", { name: "open", exact: true }).waitFor();
  await page.getByRole("button", { name: "New order", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh paper quotes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close order form", exact: true })
    .click();
  await page.getByRole("cell", { name: "filled", exact: true }).waitFor();
  await page.getByRole("button", { name: "New order", exact: true }).click();
  await page.getByLabel("Paper limit (₹)", { exact: true }).fill("50");
  await page
    .getByRole("button", { name: "Review paper order", exact: true })
    .click();
  await page
    .getByLabel("I have reviewed the contract, units and limit.")
    .check();
  await page
    .getByRole("button", { name: "Confirm paper order", exact: true })
    .click();
  await page.getByRole("button", { name: "Modify", exact: true }).click();
  await page.getByLabel("Modified limit (₹)").fill("40");
  await page
    .getByRole("button", { name: "Save paper modification", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Cancel paper order", exact: true })
    .click();
  await page.getByRole("cell", { name: "cancelled", exact: true }).waitFor();
  await page.getByRole("button", { name: "New order", exact: true }).click();
  await page.getByLabel("Paper market").selectOption("options");
  const chain = page.getByRole("region", {
    name: "Kotak option chain",
    exact: true,
  });
  await chain.getByLabel("Underlying", { exact: true }).fill("TEST");
  await chain
    .getByRole("button", { name: "Load Kotak expiries", exact: true })
    .click();
  await chain
    .getByLabel("Kotak chain expiry", { exact: true })
    .selectOption("2026-09-24");
  await chain
    .getByRole("button", { name: "Load / refresh Kotak chain", exact: true })
    .click();
  await chain
    .getByRole("button", { name: "Use paper contract", exact: true })
    .first()
    .click();
  assert.equal(
    await page.getByLabel("Paper quantity", { exact: true }).inputValue(),
    "25",
  );
  await page.getByLabel("Paper limit (₹)", { exact: true }).fill("120");
  await page
    .getByRole("button", { name: "Review paper order", exact: true })
    .click();
  await page
    .getByLabel("I have reviewed the contract, units and limit.")
    .check();
  await page
    .getByRole("button", { name: "Confirm paper order", exact: true })
    .click();
  await page.getByRole("cell", { name: "open", exact: true }).waitFor();
  await page.getByRole("button", { name: "New order", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh paper quotes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close order form", exact: true })
    .click();
  await page
    .getByRole("cell", {
      name: "OPTION:123:2026-09-24:call:25000",
      exact: true,
    })
    .waitFor();
  await mkdir("tests/artifacts", { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "tests/artifacts/kotak-only-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Algo lab", exact: true }).click();
  await page
    .getByLabel("Research name", { exact: true })
    .fill("Kotak cash research");
  await page.getByLabel("Stock code 1", { exact: true }).fill("TEST");
  await page
    .getByRole("button", { name: "Save research strategy", exact: true })
    .click();
  await page
    .getByText(
      "Saved. Choose Historical simulator or Live data preview next.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "Historical simulator", exact: true })
    .click();
  await page
    .getByLabel("Historical session (IST)", { exact: true })
    .fill("2026-09-17");
  await page
    .getByRole("button", { name: "Run historical simulation", exact: true })
    .click();
  await page
    .getByText(
      "Historical run saved. Press Play to walk through completed candles.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "Live data preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh live quotes", exact: true })
    .click();
  await page.getByRole("cell", { name: "1 · TEST", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Start Kotak live polling", exact: true })
    .click();
  await page
    .getByText("Kotak quotes every 15 seconds", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Stop Kotak live polling", exact: true })
    .click();
  /** Render real Lightweight Charts in Chromium and prove cached ticks never refetch history. */
  await page.getByRole("button", { name: "Option chain", exact: true }).click();
  const liveChain = page.getByRole("region", {
    name: "Live option chain",
    exact: true,
  });
  await liveChain
    .getByLabel("Option chain underlying", { exact: true })
    .locator("option", { hasText: "TEST" })
    .waitFor({ state: "attached" });
  await liveChain
    .getByLabel("Option chain underlying", { exact: true })
    .selectOption("TEST");
  const contractPrice = liveChain.getByRole("button", {
    name: /Inspect TEST 25000 call/,
  });
  await contractPrice.waitFor();
  await contractPrice.click();
  const historyBefore = calls.filter((call) =>
    call.url.includes("/historical/details?"),
  ).length;
  await page
    .getByRole("button", { name: "Open price chart", exact: true })
    .click();
  const chart = page.getByRole("img", {
    name: /Historical candlestick chart for TEST 25000 call/,
  });
  await chart.waitFor();
  await page.getByText(/kotak · 75 candles/).waitFor();
  assert.equal(
    calls.filter((call) => call.url.includes("/historical/details?")).length,
    historyBefore + 1,
  );
  await chart.locator("canvas").first().waitFor();
  await page
    .locator('[data-live-price="123.45"]')
    .waitFor({ state: "attached" });
  await page.locator("select[data-chart-interval]").selectOption("1minute");
  for (let i = 0; i < 20; i++) {
    if (
      calls.filter((call) => call.url.includes("/historical/details?"))
        .length ===
      historyBefore + 2
    ) {
      break;
    }
    await delay(100);
  }
  assert.equal(
    calls.filter((call) => call.url.includes("/historical/details?")).length,
    historyBefore + 2,
  );
  await delay(1500);
  assert.equal(
    calls.filter((call) => call.url.includes("/historical/details?")).length,
    historyBefore + 2,
    "live cache polling must not refetch historical candles",
  );
  await page
    .getByRole("button", { name: "Hide price chart", exact: true })
    .click();
  await chart.waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Account & security", exact: true })
    .click();
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: "Set up authenticator" }),
  });
  await form.getByLabel("Current password").fill("browser-password-long");
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await page.getByRole("button", { name: "Verify & enable MFA" }).waitFor();
  const secret = await page
    .getByLabel("Authenticator setup key", { exact: true })
    .inputValue();
  await page
    .getByLabel("6-digit authenticator code", { exact: true })
    .fill(new TOTP({ secret }).generate());
  await page.getByRole("button", { name: "Verify & enable MFA" }).click();
  await page
    .getByText("Recovery codes — shown once", { exact: true })
    .waitFor();
  assert.ok(
    calls.every(
      (call) => !/\/place|\/modify|\/cancel|\/order\//.test(call.url),
    ),
  );
  assert.deepEqual(errors, []);
  console.debug(
    "Kotak browser smoke passed: cash/options paper fills, research, chart lifecycle, cached live marks and MFA. No real broker calls.",
  );
} finally {
  await browser?.close();
  frontend?.kill("SIGTERM");
  await app.locals.shutdown();
  await new Promise((resolve) => api.close(resolve));
  await store.close();
  Date.now = realNow;
}
