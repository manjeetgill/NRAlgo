/** Browser smoke test with a real Next.js UI and an isolated PostgreSQL API.
 * Every API request is redirected to a disposable fixture: this never mutates the local user DB.
 * Broker responses are mocked; no network request or credential is sent to ICICI.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TOTP } from "otpauth";
import {
  runDatabaseMigrations,
} from "../../dist/backend/database.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { BrokerManager } from "../../dist/backend/brokers.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { FakeIciciRpc } from "../fixtures/fake-icici-rpc.mjs";
import { KotakDataManager } from "../../dist/backend/kotak-data.js";
import { fakeInstrumentCatalog } from "../fixtures/instruments.mjs";

const frontendUrl = process.env.FRONTEND_TEST_URL || "http://127.0.0.1:3010";
const store = await createPostgresTestStore();
await runDatabaseMigrations(store, {});
const brokers = new BrokerManager(() => ({
  async call(method, params) {
    if (method === "positions" || method === "holdings")
      return [
        {
          symbol: "REAL-ICICI",
          exchange: "NSE",
          product: "cash",
          quantity: 7,
          averagePrice: 100,
          markPrice: null,
          pnl: null,
          expiry: "",
          right: "",
          strike: "",
        },
      ];
    if (method === "subscribeBasket") {
      this.stream = {
        ...params,
        state: "streaming",
        quotes: params.legs.map((leg) => ({
          stockCode: leg.stockCode,
          price: 100,
          bid: 99,
          ask: 101,
          observedAt: Date.now(),
          receivedAt: Date.now(),
          stale: false,
        })),
      };
      return { ok: true };
    }
    if (method === "stopBasket") {
      if (this.stream?.streamId === params.streamId) this.stream = null;
      return { ok: true };
    }
    if (method === "optionChain")
      return [24000, 24500].map((strike_price) => ({
        stock_code: params.stockCode,
        exchange_code: "NFO",
        expiry_date: params.expiryDate,
        right: params.right,
        strike_price,
        ltp: 100,
        best_bid_price: 99,
        best_offer_price: 101,
        ltt: "02-Jan-2025 09:20:00",
        open_interest: 1000,
        total_quantity_traded: 2000,
      }));
    if (method === "quotes") {
      const date = new Date(Date.now() + 19800000);
      const ltt = `${String(date.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]}-${date.getUTCFullYear()} ${date.toISOString().slice(11, 19)}`;
      return [
        {
          stock_code: params.stockCode,
          exchange_code: params.exchangeCode,
          ltp: 100,
          best_bid_price: 99,
          best_offer_price: 101,
          ltt,
          expiry_date: params.expiryDate,
          right: params.right,
          strike_price: params.strikePrice,
        },
      ];
    }
    if (method === "historical" && params.interval === "5minute") {
      const start = Date.parse(`${params.fromDate.slice(0, 10)}T09:15:00Z`);
      return Array.from({ length: 75 }, (_, index) => ({
        datetime: new Date(start + index * 300000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " "),
        open: 100 + index,
        high: 105 + index,
        low: 98 + index,
        close: 103 + index,
        volume: 1000,
      }));
    }
    return method === "historical"
      ? [
          {
            datetime: "2025-01-01 09:15:00",
            open: 100,
            high: 105,
            low: 98,
            close: 103,
            volume: 1000,
          },
        ]
      : { ok: true };
  },
  close() {
    this.stream = null;
  },
  researchSnapshot(streamId) {
    return this.stream?.streamId === streamId ? this.stream : null;
  },
  snapshot() {
    return { state: "connected", tick: null, receivedAt: null };
  },
}));
const liveRpc = new FakeIciciRpc();
const kotakData = new KotakDataManager(async (url, init) => {
  if (url.endsWith("/tradeApiLogin"))
    return {
      data: {
        status: "success",
        kType: "View",
        token: "fake-view",
        sid: "fake-sid",
      },
    };
  if (url.endsWith("/tradeApiValidate"))
    return {
      data: {
        status: "success",
        kType: "Trade",
        token: "fake-trade",
        sid: "fake-sid",
        baseUrl: "https://cis.kotaksecurities.com",
      },
    };
  assert.equal(init.method, "GET");
  if (url.endsWith("/masterscrip/file-paths"))
    return {
      data: {
        filesPaths: [
          "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/transformed/nse_fo.csv",
        ],
      },
    };
  if (url.endsWith("/quick/user/positions"))
    return {
      stat: "Ok",
      data: [
        { trdSym: "REAL-KOTAK", exSeg: "nse_fo", prod: "NRML", qty: "-25" },
      ],
    };
  if (url.endsWith("/portfolio/v1/holdings"))
    return {
      data: [{ displaySymbol: "REAL-HOLDING", quantity: 7, averagePrice: 100 }],
    };
  assert.match(
    url,
    /\/script-details\/1.0\/quotes\/neosymbol\/nse_(cm|fo)%7C123\/all$/,
  );
  return [
    {
      exchange: url.includes("nse_fo") ? "nse_fo" : "nse_cm",
      exchange_token: "123",
      lstup_time: String(Date.now() / 1000),
      depth: { buy: [{ price: "99" }], sell: [{ price: "101" }] },
    },
  ];
});
const app = createApiApplication(
  store,
  {
    APP_ORIGIN: frontendUrl,
    BROKER_ENCRYPTION_KEY: "ab".repeat(32),
    ENABLE_LIVE_TRADING: "true",
  },
  brokers,
  () => liveRpc,
  () => true,
  kotakData,
  fakeInstrumentCatalog(),
);
const apiServer = app.listen(0, "127.0.0.1");
await new Promise((resolve) => apiServer.once("listening", resolve));
const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
let frontendProcess, browser;
try {
  if (!process.env.FRONTEND_TEST_URL)
    frontendProcess = spawn(
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
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(frontendUrl, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) break;
    } catch {}
    assert.ok(attempt < 40, "Frontend did not start");
    await delay(500);
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "darwin" ? { channel: "chrome" } : {}),
  });
  /** Create an independent browser cookie jar and intercept all API traffic before navigation. */
  async function createIsolatedPage() {
    const context = await browser.newContext();
    await context.route("**/api/**", async (route) => {
      const parsedUrl = new URL(route.request().url());
      const path = parsedUrl.pathname + parsedUrl.search;
      const response = await route.fetch({ url: `${apiUrl}${path}` });
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    return page;
  }
  const page = await createIsolatedPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.securityProbe = { executed: false, blocked: false };
    document.addEventListener("securitypolicyviolation", event => {
      if (event.violatedDirective.startsWith("script-src")) window.securityProbe.blocked = true;
    });
  });
  // Inject into the HTTP document before parsing. DevTools evaluation itself is trusted
  // and is not a valid simulation of an attacker-controlled HTML script element.
  await page.route(url => url.origin === new URL(frontendUrl).origin && url.pathname === "/", async route => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({ response, body: html.replace("</head>", "<script>window.securityProbe.executed = true</script></head>") });
  });
  const documentResponse = await page.goto(frontendUrl);
  const policy = documentResponse.headers()["content-security-policy"];
  assert.ok(policy, "HTML must carry a Content Security Policy");
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce, "CSP must carry a per-response nonce");
  const scriptPolicy = policy.split(";").find(value => value.trim().startsWith("script-src"));
  assert.ok(!scriptPolicy.includes("'unsafe-inline'"));
  assert.ok(!scriptPolicy.includes("'unsafe-eval'"));
  const anotherDocument = await fetch(frontendUrl, {
    headers: { "Content-Security-Policy": "script-src * 'unsafe-inline'", "x-nonce": "attacker-chosen" },
  });
  const anotherPolicy = anotherDocument.headers.get("content-security-policy");
  assert.notEqual(/'nonce-([^']+)'/.exec(anotherPolicy)?.[1], nonce);
  assert.ok(!anotherPolicy.includes("attacker-chosen"));
  await anotherDocument.text();
  await page.waitForFunction(() => window.securityProbe.blocked);
  assert.equal(await page.evaluate(() => window.securityProbe.executed), false);
  await page.getByLabel("Username", { exact: true }).fill("browser-owner");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-password-long");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("button", { name: "Brokers", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).fill("browser-api-key");
  const loginUrl = await page
    .getByRole("link", { name: "Open secure ICICI login" })
    .getAttribute("href");
  assert.ok(
    loginUrl.startsWith("https://api.icicidirect.com/apiuser/login?api_key="),
  );
  await page.getByLabel("API secret", { exact: true }).fill("browser-secret");
  await page
    .getByLabel("API session token", { exact: true })
    .fill("browser-token");
  await page.getByRole("button", { name: "Connect & save securely" }).click();
  await page.getByText("ICICI connected.", { exact: false }).waitFor();
  assert.equal(
    await page.getByLabel("API secret", { exact: true }).inputValue(),
    "",
  );
  await page.getByLabel("From (your local time)").fill("2025-01-01T09:15");
  await page.getByLabel("To (your local time)").fill("2025-01-01T10:15");
  await page.getByRole("button", { name: "Load historical candles" }).click();
  await page.getByRole("cell", { name: "103", exact: true }).waitFor();
  await mkdir("tests/artifacts", { recursive: true });
  await page.screenshot({ path: "tests/artifacts/browser-smoke.png", fullPage: true });
  // Fix only the offline fixture clock during paper checks so the suite also runs outside market hours.
  const realPaperClock = Date.now;
  try {
    Date.now = () => Date.parse("2026-09-18T05:00:00Z");
    await page
      .getByRole("button", { name: "Broker paper", exact: true })
      .click();
    await page.getByLabel("Breeze paper stock code").fill("TEST");
    await page.getByLabel("Instrument search", { exact: true }).fill("TEST");
    await page
      .getByRole("button", { name: "Search broker instruments", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select TEST cash", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Breeze paper stock code").isDisabled(),
      true,
    );
    await page.getByLabel("Paper limit (₹)", { exact: true }).fill("120");
    await page
      .getByRole("button", { name: "Place paper order", exact: true })
      .click();
    await page.getByRole("cell", { name: "open", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Refresh paper quotes", exact: true })
      .click();
    await page.getByRole("cell", { name: "filled", exact: true }).waitFor();
    await page.getByLabel("Paper data broker").selectOption("kotak");
    await page.getByLabel("Kotak API access token").fill("fake-browser-token");
    await page.getByLabel("Mobile (+91…)").fill("+919999999999");
    await page.getByLabel("Kotak client code (UCC)").fill("FAKE");
    await page.getByLabel("Kotak TOTP").fill("123456");
    await page.getByLabel("Kotak MPIN").fill("123456");
    await page
      .getByRole("button", { name: "Connect Kotak data", exact: true })
      .click();
    await page.getByText("Kotak connected for market data only.").waitFor();
    assert.equal(await page.getByLabel("Kotak MPIN").inputValue(), "");
    await page.getByLabel("Kotak NSE cash token (pSymbol)").fill("123");
    await page.getByLabel("Paper limit (₹)", { exact: true }).fill("120");
    await page
      .getByRole("button", { name: "Place paper order", exact: true })
      .click();
    await page.getByRole("cell", { name: "open", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Refresh paper quotes", exact: true })
      .click();
    await page.getByRole("cell", { name: "filled", exact: true }).waitFor();
    await page.getByLabel("Paper limit (₹)", { exact: true }).fill("50");
    await page
      .getByRole("button", { name: "Place paper order", exact: true })
      .click();
    await page.getByRole("button", { name: "Modify", exact: true }).click();
    await page.getByLabel("Modified limit (₹)").fill("40");
    await page
      .getByRole("button", { name: "Save paper modification", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Cancel paper order", exact: true })
      .click();
    await page.getByRole("cell", { name: "cancelled", exact: true }).waitFor();
    await page.getByLabel("Paper market").selectOption("options");
    await page.getByLabel("Instrument search", { exact: true }).fill("TEST");
    await page
      .getByRole("button", { name: "Search broker instruments", exact: true })
      .click();
    await page.getByLabel("Picker underlying").selectOption("TEST");
    await page.getByLabel("Picker expiry").selectOption("2026-09-24");
    await page.getByLabel("Picker option type").selectOption("call");
    await page
      .getByRole("button", { name: "Search broker instruments", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Select TEST 2026-09-24 25000 call",
        exact: true,
      })
      .click();
    assert.equal(
      await page.getByLabel("Paper quantity", { exact: true }).inputValue(),
      "25",
    );
    assert.equal(await page.getByLabel("Option expiry").isDisabled(), true);
    assert.equal(await page.getByLabel("Declared lot size").inputValue(), "25");
    await page.getByLabel("Paper limit (₹)", { exact: true }).fill("120");
    await page
      .getByRole("button", { name: "Place paper order", exact: true })
      .click();
    await page.getByRole("cell", { name: "open", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Refresh paper quotes", exact: true })
      .click();
    await page
      .getByRole("cell", {
        name: "OPTION:123:2026-09-24:call:25000",
        exact: true,
      })
      .waitFor();
    assert.equal(liveRpc.placementCalls, 0);
    await page.screenshot({
      path: "tests/artifacts/broker-paper-smoke.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "tests/artifacts/broker-paper-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole("button", { name: "View broker portfolio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh broker portfolio", exact: true })
      .click();
    await page.getByRole("cell", { name: "REAL-KOTAK", exact: true }).waitFor();
    await page
      .getByRole("cell", { name: "REAL-HOLDING", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Paper positions", exact: true })
        .count(),
      0,
    );
    await page.screenshot({
      path: "tests/artifacts/broker-portfolio-smoke.png",
      fullPage: true,
    });
    await page.getByLabel("Paper data broker").selectOption("icici");
    assert.equal(
      await page.getByRole("cell", { name: "REAL-KOTAK", exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Refresh broker portfolio", exact: true })
      .click();
    await page
      .getByRole("cell", { name: "REAL-ICICI", exact: true })
      .first()
      .waitFor();
    assert.equal(liveRpc.placementCalls, 0);
  } finally {
    Date.now = realPaperClock;
  }
  // Research never calls the execution double, even when preparing a cash ticket.
  await page.getByRole("button", { name: "Strategy lab", exact: true }).click();
  await page
    .getByLabel("Research name", { exact: true })
    .fill("Browser cash research");
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
    .fill("2025-01-02");
  await page
    .getByRole("button", { name: "Run historical simulation", exact: true })
    .click();
  await page
    .getByText(
      "Historical run saved. Press Play to walk through completed candles.",
      { exact: true },
    )
    .waitFor();
  await page.getByLabel("Replay candle", { exact: true }).focus();
  await page.getByLabel("Replay candle", { exact: true }).press("End");
  await page
    .getByRole("cell", { name: "scheduled exit", exact: true })
    .waitFor();
  await page.screenshot({
    path: "tests/artifacts/research-cash-smoke.png",
    fullPage: true,
  });
  await page
    .getByLabel("Batch session dates (YYYY-MM-DD, comma separated)")
    .fill("2025-01-02, 2025-01-03");
  await page
    .getByRole("button", { name: "Run batch backtest", exact: true })
    .click();
  await page
    .getByText("Batch saved: 2 completed, 0 skipped or not attempted.", {
      exact: true,
    })
    .waitFor();
  await page.getByLabel("Batch replay session").selectOption("2025-01-03");
  assert.equal(
    await page.getByLabel("Batch replay session").inputValue(),
    "2025-01-03",
  );
  const savedBatch = await page
    .getByLabel("Saved replay", { exact: true })
    .locator("option")
    .nth(1)
    .getAttribute("value");
  await page
    .getByLabel("Saved replay", { exact: true })
    .selectOption(savedBatch);
  await page.getByLabel("Batch replay session").selectOption("2025-01-02");
  await page.screenshot({
    path: "tests/artifacts/research-batch-smoke.png",
    fullPage: true,
  });
  assert.equal(liveRpc.placementCalls, 0);
  await page
    .getByRole("button", { name: "Live data preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh live quotes", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Review cash order in Live trading",
      exact: true,
    })
    .click();
  assert.equal(
    await page.getByLabel("Breeze stock code", { exact: true }).inputValue(),
    "TEST",
  );
  assert.equal(liveRpc.placementCalls, 0);
  await page.getByRole("button", { name: "Strategy lab", exact: true }).click();
  await page
    .getByRole("button", { name: "Long straddle", exact: true })
    .click();
  await page.getByLabel("Expiry 1", { exact: true }).fill("2030-01-31");
  await page.getByLabel("Expiry 2", { exact: true }).fill("2030-01-31");
  await page.getByLabel("Chain expiry", { exact: true }).fill("2030-01-31");
  await page
    .getByRole("button", { name: "Load option chain", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use 24000 call buy", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Strike 1", { exact: true }).inputValue(),
    "24000",
  );
  await page.screenshot({
    path: "tests/artifacts/option-chain-smoke.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save research strategy", exact: true })
    .click();
  await page
    .getByText(
      "Saved. Choose Historical simulator or Live data preview next.",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: "tests/artifacts/research-builder-smoke.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Historical simulator", exact: true })
    .click();
  await page
    .getByLabel("Historical session (IST)", { exact: true })
    .fill("2025-01-02");
  await page
    .getByRole("button", { name: "Run historical simulation", exact: true })
    .click();
  await page
    .getByText(
      "Historical run saved. Press Play to walk through completed candles.",
      { exact: true },
    )
    .waitFor();
  await page.getByLabel("Replay candle", { exact: true }).focus();
  await page.getByLabel("Replay candle", { exact: true }).press("End");
  assert.equal(
    await page
      .getByRole("cell", { name: "scheduled exit", exact: true })
      .count(),
    2,
  );
  await page
    .getByRole("button", { name: "Live data preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh live quotes", exact: true })
    .click();
  await page.getByText("Illustrative expiry payoff", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Start basket stream", exact: true })
    .click();
  await page.getByText("Feed: streaming", { exact: true }).waitFor();
  await page.screenshot({
    path: "tests/artifacts/basket-stream-smoke.png",
    fullPage: true,
  });
  assert.equal(liveRpc.placementCalls, 0);
  await page
    .getByRole("button", { name: "Stop research stream", exact: true })
    .click();
  await page.getByText("Feed stopped", { exact: true }).waitFor();
  // Reload one read-only snapshot so the remaining payoff/mobile checks still cover both paths.
  await page
    .getByRole("button", { name: "Refresh live quotes", exact: true })
    .click();
  await page.getByText("Illustrative expiry payoff", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", {
        name: "Review cash order in Live trading",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal(liveRpc.placementCalls, 0);
  await page.screenshot({
    path: "tests/artifacts/research-options-smoke.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "tests/artifacts/research-mobile-smoke.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("button", { name: "Account & security", exact: true })
    .click();
  const setupForm = page.locator("form").filter({
    has: page.getByRole("button", { name: "Set up authenticator" }),
  });
  await setupForm.getByLabel("Current password").fill("browser-password-long");
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await page.getByRole("button", { name: "Verify & enable MFA" }).waitFor();
  const secret = await page.locator("input[readonly]").inputValue();
  await page
    .getByLabel("6-digit authenticator code", { exact: true })
    .fill(new TOTP({ secret }).generate());
  await page.getByRole("button", { name: "Verify & enable MFA" }).click();
  await page
    .getByText("Recovery codes — shown once", { exact: true })
    .waitFor();
  const recoveryCode = (await page.locator("pre").innerText()).split("\n")[0];
  await page.getByRole("button", { name: "Live trading", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect / verify ICICI", exact: true })
    .click();
  await page
    .getByText("ICICI checked. Review account state before enabling live.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("App account password", { exact: true })
    .fill("browser-password-long");
  await page
    .getByLabel("Fresh authenticator / recovery code", { exact: true })
    .fill(recoveryCode);
  await page
    .getByLabel("Type ENABLE LIVE TRADING", { exact: true })
    .fill("ENABLE LIVE TRADING");
  await page
    .getByLabel(
      "I confirmed the server’s registered static IP and understand this uses real money.",
    )
    .check();
  await page
    .getByRole("button", { name: "Enable live for 15 minutes", exact: true })
    .click();
  await page.getByText("LIVE ARMED", { exact: true }).waitFor();
  await page.getByLabel("Breeze stock code", { exact: true }).fill("TEST");
  await page.getByLabel("Limit price (₹)", { exact: true }).fill("10");
  await page
    .getByRole("button", {
      name: "Review order — no submission yet",
      exact: true,
    })
    .click();
  await page
    .getByRole("region", { name: "Confirm real-money order" })
    .waitFor();
  assert.equal(liveRpc.placementCalls, 0);
  await page
    .getByRole("button", { name: "Confirm & place REAL order", exact: true })
    .click();
  await page.getByText("acknowledged", { exact: true }).waitFor();
  assert.equal(liveRpc.placementCalls, 1);
  await page.screenshot({
    path: "tests/artifacts/live-browser-smoke.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Switch to paper", exact: true })
    .click();
  await page
    .getByText("A clearer view of your edge.", { exact: true })
    .waitFor();
  assert.ok(liveRpc.cancelCalls > 0);
  const second = await createIsolatedPage();
  await second.goto(frontendUrl);
  await second.getByRole("button", { name: "Create another account" }).click();
  await second
    .getByLabel("Username", { exact: true })
    .fill("browser-second-user");
  await second
    .getByLabel("Password", { exact: true })
    .fill("second-password-long");
  await second
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await second.getByRole("button", { name: "Brokers", exact: true }).click();
  assert.equal(
    await second
      .getByRole("button", { name: "Reconnect saved account" })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: ICICI/Kotak paper fills, modification/cancellation, mobile layout, option-chain selection, multi-leg streams, history, MFA, guarded fake live order and paper-return cancellation.",
  );
} finally {
  await browser?.close();
  frontendProcess?.kill("SIGTERM");
  brokers.close();
  await app.locals.shutdown();
  await new Promise((resolve) => apiServer.close(resolve));
  await store.close();
}
