/** Mocked transport tests only: these tests never contact, authenticate or trade with a broker. */
import assert from "node:assert/strict";
import test from "node:test";
import { kotakAccountAdapter } from "../../frontend/src/features/overview/providers/kotak-account-adapter";

test("11-T02 long valuation is 300; missing mark cannot display an old broker P&L as current", async () => {
  for (const markPrice of [2940, null]) {
    await withResponse(
      {
        positions: {
          rows: [{ quantity: 10, averagePrice: 2910, markPrice, pnl: 300 }],
        },
      },
      async () => {
        const snapshot = await kotakAccountAdapter.loadLiveAccount("test-csrf");
        assert.equal(snapshot.pnl, markPrice === null ? null : 300);
      },
    );
  }
});

/** Install a scoped HTTP stub and restore global fetch even when an assertion fails. */
async function withResponse(
  payload: unknown,
  verify: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch =
    /** Resolve a synthetic API response and record its exact read/subscription intent. */ async (
      input,
      init,
    ) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  try {
    await verify(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("paper adapter converts paise and subtracts reservations without requesting order history", /** Assert virtual ledger isolation and one GET request. */ async () => {
  await withResponse(
    {
      connected: true,
      positions: {
        "OPTION:NIFTY:2026-09-22:call:23000": {
          quantity: 10,
          costPaise: 90000,
        },
      },
      marks: {
        "OPTION:NIFTY:2026-09-22:call:23000": { bid: 10000, observedAt: 1000 },
      },
      cashPaise: 100000,
      reservedPaise: 10000,
      realizedPaise: 500,
      unrealizedPaise: 10000,
    },
    /** Inspect normalized values, not broker-specific fields in the screen. */ async (
      calls,
    ) => {
      const { snapshot, connected } =
        await kotakAccountAdapter.loadPaperAccount();
      assert.equal(connected, true);
      assert.equal(snapshot.availableFunds, 900);
      assert.equal(snapshot.pnl, 105);
      assert.equal(snapshot.positions![0].pnl, 100);
      assert.equal(snapshot.positions![0].averagePrice, 90);
      assert.deepEqual(
        calls.map(
          /** Keep the assertion focused on HTTP endpoint identity. */ (call) =>
            call.url,
        ),
        ["/api/paper/kotak"],
      );
      assert.equal(calls[0].init?.method, "GET");
    },
  );
});

test("malformed paper accounts reject instead of looking flat", /** Missing positions or connection state must not create invented balances. */ async () => {
  await withResponse(
    { connected: true },
    /** Consume the rejection as an explicit unavailable state. */ async () => {
      await assert.rejects(
        kotakAccountAdapter.loadPaperAccount(),
        /incomplete/,
      );
    },
  );
});

test("live reports preserve unknown positions while retaining known funds", /** Partial broker failure is not an empty portfolio. */ async () => {
  await withResponse(
    {
      limits: { rows: [{ available: 42.5 }] },
      positions: { rows: null, error: "Positions unavailable" },
      observedAt: 2000,
    },
    /** Validate one CSRF-protected report read and unchanged INR units. */ async (
      calls,
    ) => {
      const snapshot = await kotakAccountAdapter.loadLiveAccount("test-csrf");
      assert.equal(snapshot.pnl, null);
      assert.equal(snapshot.positions, null);
      assert.equal(snapshot.availableFunds, 42.5);
      assert.deepEqual(snapshot.warnings, ["Positions unavailable"]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/brokers/kotak/overview");
      assert.equal(calls[0].init?.method, "POST");
      assert.equal(
        (calls[0].init?.headers as Record<string, string>)["X-CSRF-Token"],
        "test-csrf",
      );
    },
  );
});

test("live adapter filters closed positions and retains streaming coefficients", /** Only open-position P&L feeds the Overview headline. */ async () => {
  await withResponse(
    {
      positions: {
        rows: [
          { quantity: 0, pnl: 1000 },
          {
            quantity: 10,
            symbol: "NIFTY CE",
            instrumentToken: "101",
            exchange: "nse_fo",
            pnl: 25,
            pnlBase: -975,
            pnlPerMark: 10,
            markPrice: 100,
          },
        ],
      },
    },
    /** Verify exact token/exchange identity and unknown funds. */ async () => {
      const snapshot = await kotakAccountAdapter.loadLiveAccount("test-csrf");
      assert.equal(snapshot.positions!.length, 1);
      assert.equal(snapshot.pnl, 25);
      assert.equal(snapshot.positions![0].pnlPerMark, 10);
      assert.equal(snapshot.positions![0].instrument, "101");
      assert.equal(snapshot.availableFunds, null);
    },
  );
});

test("invalid live quantity makes the book unknown", /** A malformed row cannot masquerade as a closed position. */ async () => {
  await withResponse(
    { positions: { rows: [{ quantity: null, pnl: 10 }] } },
    /** Preserve null and surface a diagnostic warning. */ async () => {
      const snapshot = await kotakAccountAdapter.loadLiveAccount("test-csrf");
      assert.equal(snapshot.positions, null);
      assert.equal(snapshot.pnl, null);
      assert.match(snapshot.warnings[0], /incomplete/);
    },
  );
});

test("stream operations use only subscription and cached-price endpoints", /** No execution or recurring account-history API is reachable through these methods. */ async () => {
  await withResponse(
    {
      records: [
        {
          instrument: "101",
          exchange: "nse_fo",
          ltp: 105,
          receivedAt: 2000,
          receivedRecently: true,
        },
      ],
    },
    /** Validate normalization and the two explicit network operations. */ async (
      calls,
    ) => {
      await kotakAccountAdapter.startPositionFeed("test-csrf");
      assert.deepEqual(await kotakAccountAdapter.readPriceTicks(), [
        {
          instrument: "101",
          exchange: "nse_fo",
          price: 105,
          receivedAt: 2000,
          fresh: true,
        },
      ]);
      assert.deepEqual(
        calls.map(
          /** Inspect each path without leaking request headers. */ (call) =>
            call.url,
        ),
        ["/api/market/live-feed", "/api/market/feed"],
      );
    },
  );
});
