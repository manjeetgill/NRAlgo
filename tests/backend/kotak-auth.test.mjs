/** Offline authentication diagnostics: never contact a broker or use account credentials. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  KotakMarketDataClient,
  sendKotakHttpRequest,
  kotakLoginSchema,
  validateKotakOrigin,
} from "../../dist/backend/kotak-market-data-client.js";

const secret = "private-test-value-must-not-escape";
/** Exact data-center allowlist rejects SSRF targets and ambiguous URL normalization. */
test("Kotak allows documented production origins only", () => {
  for (const host of ["mis", "cis", "e21", "e22", "e41", "e43"]) {
    const origin = `https://${host}.kotaksecurities.com`;
    assert.equal(validateKotakOrigin(origin), origin);
    assert.equal(validateKotakOrigin(`${origin}/`), origin);
  }
  for (const url of [
    undefined,
    null,
    "",
    "https://e99.kotaksecurities.com",
    "https://d-mis.kotaksecurities.com",
    "https://evil.example",
    "https://e43.kotaksecurities.com.evil.example",
    "http://e43.kotaksecurities.com",
    "https://e43.kotaksecurities.com:443",
    "https://e43.kotaksecurities.com:8443",
    "https://user:password@e43.kotaksecurities.com",
    "https://127.0.0.1",
    "https://e43.kotaksecurities.com/path",
    "https://e43.kotaksecurities.com/../",
    "https://e43.kotaksecurities.com/?token=secret",
    "https://e43.kotaksecurities.com/#fragment",
    "https://e43.kotaksecurities.com//",
    " https://e43.kotaksecurities.com",
    "https://e43.kotaksecurities.com\n",
    "https://e43.kotaksecurities.com\\evil",
  ]) {
    assert.throws(() => validateKotakOrigin(url));
  }
});

/** A login-assigned data center must carry through to reads, never a hardcoded fallback. */
test("Kotak routes quotes to the authenticated account data center", async () => {
  for (const host of ["mis", "cis", "e21", "e22", "e41", "e43"]) {
    const origin = `https://${host}.kotaksecurities.com`;
    const calls = [];
    const manager = new KotakMarketDataClient(async (url) => {
      calls.push(url);
      if (url.endsWith("tradeApiLogin")) {
        return success("View");
      }
      if (url.endsWith("tradeApiValidate")) {
        return { data: { ...success("Trade").data, baseUrl: `${origin}/` } };
      }
      return [
        {
          exchange: "nse_cm",
          exchange_token: "123",
          lstup_time: Math.floor(Date.now() / 1000),
          depth: { buy: [{ price: "100" }], sell: [{ price: "101" }] },
        },
      ];
    });
    await manager.connect("user", "session", Date.now() + 60000, login);
    const quote = await manager.getPaperFillQuote("user", "session", "123");
    assert.equal(quote.ask, 10100);
    assert.equal(
      calls[2],
      `${origin}/script-details/1.0/quotes/neosymbol/nse_cm%7C123/all`,
    );
    manager.disconnect("user");
  }
});
const login = {
  accessToken: secret,
  mobileNumber: "+919999999999",
  ucc: "FAKE",
  totp: "123456",
  mpin: "654321",
};
const success = (kType) => ({
  data: {
    status: "success",
    kType,
    token: secret,
    sid: secret,
    baseUrl: "https://cis.kotaksecurities.com",
  },
});

/** All public diagnostics must identify the stage without retaining untrusted response values. */
async function expectFailure(transport, expected) {
  const manager = new KotakMarketDataClient(transport);
  await assert.rejects(
    manager.connect("user", "session", Date.now() + 60000, login),
    (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.status, 502);
      assert.ok(error.detail.includes(expected));
      assert.ok(!`${error.message}${JSON.stringify(error)}`.includes(secret));
      return true;
    },
  );
  assert.equal(manager.isConnected("user", "session"), false);
}

test("Kotak diagnostics distinguish rejected, malformed, host and MPIN stages", async () => {
  await expectFailure(
    async () => ({ status: "error", message: secret }),
    "KOTAK_TOTP_LOGIN_REJECTED",
  );
  await expectFailure(
    async () => ({ data: secret }),
    "KOTAK_TOTP_LOGIN_UNEXPECTED_RESPONSE",
  );
  await expectFailure(
    async () => success("Trade"),
    "KOTAK_TOTP_LOGIN_UNEXPECTED_RESPONSE",
  );
  await expectFailure(
    async (url) =>
      url.endsWith("tradeApiLogin")
        ? success("View")
        : { status: "error", message: secret },
    "KOTAK_MPIN_VERIFY_REJECTED",
  );
  await expectFailure(
    async (url) =>
      url.endsWith("tradeApiLogin")
        ? success("View")
        : {
            data: {
              ...success("Trade").data,
              baseUrl: `https://${secret}.example.com`,
            },
          },
    "KOTAK_HOST_VALIDATION_UNSUPPORTED_HOST",
  );
  await expectFailure(async () => {
    throw new Error(secret);
  }, "KOTAK_TOTP_LOGIN_REQUEST_FAILED");
});

test("Kotak transport safely classifies HTTP, timeout, network and malformed bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403, 429, 502, 503]) {
      globalThis.fetch = async () => new Response(secret, { status });
      await expectFailure(
        sendKotakHttpRequest,
        `KOTAK_TOTP_LOGIN_HTTP_${status}`,
      );
    }
    globalThis.fetch = async () => {
      throw new DOMException(secret, "TimeoutError");
    };
    await expectFailure(sendKotakHttpRequest, "KOTAK_TOTP_LOGIN_TIMEOUT");
    globalThis.fetch = async () => {
      throw new TypeError(secret);
    };
    await expectFailure(sendKotakHttpRequest, "KOTAK_TOTP_LOGIN_NETWORK_ERROR");
    globalThis.fetch = async () => new Response(secret);
    await expectFailure(
      sendKotakHttpRequest,
      "KOTAK_TOTP_LOGIN_UNEXPECTED_RESPONSE",
    );
    globalThis.fetch = async () => new Response("x".repeat(262145));
    await expectFailure(
      sendKotakHttpRequest,
      "KOTAK_TOTP_LOGIN_RESPONSE_TOO_LARGE",
    );
    globalThis.fetch = async (url) =>
      url.endsWith("tradeApiLogin")
        ? Response.json(success("View"))
        : new Response(secret, { status: 401 });
    await expectFailure(sendKotakHttpRequest, "KOTAK_MPIN_VERIFY_HTTP_401");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kotak success remains session-bound and credential whitespace is normalized", async () => {
  const manager = new KotakMarketDataClient(async (url) =>
    success(url.endsWith("tradeApiLogin") ? "View" : "Trade"),
  );
  await manager.connect("user", "session", Date.now() + 60000, login);
  assert.equal(manager.isConnected("user", "session"), true);
  assert.equal(manager.isConnected("user", "other-session"), false);
  assert.equal(
    kotakLoginSchema.parse({ ...login, totp: " 123456 " }).totp,
    "123456",
  );
  assert.equal(
    kotakLoginSchema.safeParse({ ...login, mobileNumber: "9999999999" })
      .success,
    false,
  );
});

/** Broker rejection text reaches the UI detail, while raw payloads and credentials never do. */
test("Kotak exposes redacted broker codes and messages on HTTP failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const payload of [
      {
        error: [
          { code: "400", message: "Missing required field 'MobileNumber'" },
        ],
      },
      {
        status: "error",
        errorCode: "400",
        message: "Missing required field 'MobileNumber'",
      },
      { data: { Code: 400, Message: "Missing required field 'MobileNumber'" } },
    ]) {
      globalThis.fetch = async () => Response.json(payload, { status: 400 });
      await assert.rejects(
        new KotakMarketDataClient().connect(
          "user",
          "session",
          Date.now() + 60000,
          login,
        ),
        (error) => {
          assert.match(
            error.detail,
            /Broker response: \[400\] Missing required field 'MobileNumber'/,
          );
          assert.equal(error.code, "KOTAK_TOTP_LOGIN_HTTP_400");
          return true;
        },
      );
    }
    const responseToken = "new-server-session-secret";
    globalThis.fetch = async () =>
      Response.json(
        {
          token: responseToken,
          message: `Invalid input ${Object.values(login).join(" ")} ${responseToken} token=shortsecret https://example.com/?secret=abc`,
          debug: "PRIVATE_DEBUG_MUST_NOT_LEAVE_SERVER",
        },
        { status: 400 },
      );
    await assert.rejects(
      new KotakMarketDataClient().connect(
        "user",
        "session",
        Date.now() + 60000,
        login,
      ),
      (error) => {
        const serialized = JSON.stringify(error);
        assert.match(error.detail, /Broker response: Invalid input/);
        for (const privateValue of [
          ...Object.values(login),
          responseToken,
          "shortsecret",
          "PRIVATE_DEBUG_MUST_NOT_LEAVE_SERVER",
          "example.com",
        ]) {
          assert.ok(
            !serialized.includes(privateValue),
            "Private field was exposed",
          );
        }
        return true;
      },
    );
    globalThis.fetch = async () =>
      new Response("<html>PRIVATE_GATEWAY_BODY</html>", { status: 502 });
    await assert.rejects(
      new KotakMarketDataClient().connect(
        "user",
        "session",
        Date.now() + 60000,
        login,
      ),
      (error) => {
        assert.equal(error.code, "KOTAK_TOTP_LOGIN_HTTP_502");
        assert.ok(!error.detail.includes("PRIVATE_GATEWAY_BODY"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** HTTP-200 error envelopes must retain useful broker diagnostics too. */
test("Kotak displays broker rejection text for successful HTTP envelopes", async () => {
  const manager = new KotakMarketDataClient(async () => ({
    status: "error",
    errorCode: "401",
    message: `Invalid TOTP ${login.totp}`,
  }));
  await assert.rejects(
    manager.connect("user", "session", Date.now() + 60000, login),
    (error) => {
      assert.match(
        error.detail,
        /Broker response: \[401\] Invalid TOTP \[redacted\]/,
      );
      assert.ok(!error.detail.includes(login.totp));
      return true;
    },
  );
});

/** Display quotes fail closed on identity corruption; absent instruments remain visibly unavailable. */
test("Kotak snapshot batches validate identity, freshness and session ownership", async () => {
  let rows = [];
  const manager = new KotakMarketDataClient(async (url) =>
    url.endsWith("tradeApiLogin")
      ? success("View")
      : url.endsWith("tradeApiValidate")
        ? success("Trade")
        : rows,
  );
  await manager.connect("user", "session", Date.now() + 60000, login);
  await assert.rejects(
    manager.getQuoteSnapshots("user", "other-session", ["123"]),
    /Connect/,
  );
  await assert.rejects(
    manager.getQuoteSnapshots(
      "user",
      "session",
      Array.from({ length: 51 }, (_, index) => String(index + 1)),
    ),
    /Invalid/,
  );
  let result = await manager.getQuoteSnapshots("user", "session", ["123"]);
  assert.equal(result[0].price, null);
  assert.equal(result[0].stale, true);
  rows = [
    {
      exchange: "nse_fo",
      exchange_token: "123",
      ltp: "100",
      lstup_time: String(Math.floor(Date.now() / 1000) - 60),
    },
  ];
  result = await manager.getQuoteSnapshots("user", "session", ["123"]);
  assert.equal(result[0].price, 100);
  assert.equal(result[0].stale, true);
  assert.equal(result[0].bid, null);
  rows = [{ exchange: "nse_cm", exchange_token: "123" }];
  await assert.rejects(
    manager.getQuoteSnapshots("user", "session", ["123"]),
    /identity/,
  );
  rows = [{ exchange: "nse_fo", exchange_token: "999" }];
  await assert.rejects(
    manager.getQuoteSnapshots("user", "session", ["123"]),
    /identity/,
  );
  rows = [
    { exchange: "nse_fo", exchange_token: "123" },
    { exchange: "nse_fo", exchange_token: "123" },
  ];
  await assert.rejects(
    manager.getQuoteSnapshots("user", "session", ["123", "124"]),
    /identity/,
  );
});

/** Mid-request disconnects cannot attach cached quotes to a new login generation. */
test("Kotak rejects snapshots arriving after disconnect", async () => {
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const manager = new KotakMarketDataClient(async (url) => {
    if (url.endsWith("tradeApiLogin")) {
      return success("View");
    }
    if (url.endsWith("tradeApiValidate")) {
      return success("Trade");
    }
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await manager.connect("user", "session", Date.now() + 60000, login);
  const pending = manager.getQuoteSnapshots("user", "session", ["123"]);
  await waiting;
  manager.disconnect("user");
  release([]);
  await assert.rejects(pending, /session changed/);
});
