import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConstituents } from "../../frontend/src/lib/index-constituents.ts";
import { GET } from "../../frontend/src/app/reference/index-constituents/route.ts";

test("official CSV parsing handles quoted company names and rejects invalid payloads", () => {
  assert.deepEqual(
    parseConstituents(
      'Company Name,Symbol\n"Example, Ltd",ABC\nAnother,M&M\nAgain,ABC\n',
    ),
    ["ABC", "M&M"],
  );
  for (const input of [
    "<html>Denied</html>",
    "Company,Ticker\nTest,ABC",
    "Symbol\n<script>",
    "Symbol\n",
  ]) {
    assert.throws(() => parseConstituents(input));
  }
});

test("membership route allowlists sources, caches per index, and fails closed", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.headers["User-Agent"], "Mozilla/5.0");
    assert.equal(options.headers.Referer, "https://www.niftyindices.com/");
    requests++;
    assert.match(url, /^https:\/\/www\.niftyindices\.com\/IndexConstituent\//);
    if (url.endsWith("ind_niftybanklist.csv")) {
      return new Response("Symbol\nBANKA\nBANKB\n");
    }
    if (url.endsWith("ind_nifty50list.csv")) {
      return new Response("Symbol\nOTHER\n");
    }
    throw new Error("Network unavailable");
  });
  const get = (index) =>
    GET(
      new Request(
        `http://localhost/reference/index-constituents?index=${index}`,
      ),
    );
  for (const invalid of ["UNKNOWN", "constructor", "__proto__"]) {
    assert.equal((await get(invalid)).status, 400);
  }
  assert.equal(requests, 0);
  const [bank1, bank2] = await Promise.all([
    get("BANKNIFTY"),
    get("BANKNIFTY"),
  ]);
  assert.deepEqual((await bank1.json()).symbols, ["BANKA", "BANKB"]);
  assert.deepEqual((await bank2.json()).symbols, ["BANKA", "BANKB"]);
  assert.equal(requests, 1);
  await get("BANKNIFTY");
  assert.equal(requests, 1);
  assert.deepEqual((await (await get("NIFTY")).json()).symbols, ["OTHER"]);
  assert.equal((await get("FINNIFTY")).status, 503);
  assert.equal((await get("FINNIFTY")).status, 503);
  assert.equal(requests, 3);
});
