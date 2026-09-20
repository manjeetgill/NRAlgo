import assert from "node:assert/strict";
import test from "node:test";
import {
  KotakConnectionError,
  KotakMarketDataClient,
} from "../backend/kotak-market-data-client.ts";

const login = (suffix) => ({
  accessToken: `test-access-token-${suffix}`,
  mobileNumber: "+919999999999",
  ucc: "TEST01",
  totp: "123456",
  mpin: "654321",
});

const successfulLogin = (suffix) => [
  {
    data: {
      status: "success",
      kType: "View",
      token: `view-token-${suffix}`,
      sid: `view-sid-${suffix}`,
    },
  },
  {
    data: {
      status: "success",
      kType: "Trade",
      token: `trade-token-${suffix}`,
      sid: `trade-sid-${suffix}`,
      baseUrl: "https://cis.kotaksecurities.com",
    },
  },
];

test("failed Kotak re-login preserves the current execution session", async () => {
  const responses = [
    ...successfulLogin("first"),
    { status: "error", message: "invalid fixture TOTP", errorCode: "401" },
  ];
  const client = new KotakMarketDataClient(async () => responses.shift());
  const expires = Date.now() + 60_000;
  await client.connect("user", "app-session", expires, login("first"));
  const execution = client.executionSession("user", "app-session");

  await assert.rejects(
    client.connect("user", "app-session", expires, login("second")),
    (error) => error instanceof KotakConnectionError,
  );

  assert.equal(client.isConnected("user", "app-session"), true);
  assert.equal(execution.isCurrent(), true);
  assert.equal(
    client.savedSession("user", "app-session")?.token,
    "trade-token-first",
  );
  client.close();
});

test("successful Kotak re-login atomically fences the previous execution session", async () => {
  const responses = [...successfulLogin("first"), ...successfulLogin("second")];
  const client = new KotakMarketDataClient(async () => responses.shift());
  const expires = Date.now() + 60_000;
  await client.connect("user", "app-session", expires, login("first"));
  const previous = client.executionSession("user", "app-session");

  await client.connect("user", "app-session", expires, login("second"));
  const replacement = client.executionSession("user", "app-session");

  assert.equal(previous.isCurrent(), false);
  assert.equal(replacement.isCurrent(), true);
  assert.equal(
    client.savedSession("user", "app-session")?.token,
    "trade-token-second",
  );
  client.close();
});
