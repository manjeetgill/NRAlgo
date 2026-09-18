/** Master schema, units, URL boundaries and cache tests; never use a real broker or network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseInstrumentCsv,
  validateKotakMasterUrl,
  instrumentSearchSchema,
} from "../../dist/backend/instrument-master.js";
import {
  kotakCashCsv,
  kotakOptionCsv,
  fakeInstrumentCatalog,
} from "../fixtures/instruments.mjs";
test("Kotak master resolves exact cash/option identities, lots and expiry/paise units", () => {
  assert.equal(
    parseInstrumentCsv("kotak", "cash", kotakCashCsv)[0].instrument,
    "123",
  );
  for (const [broker, csv] of [["kotak", kotakOptionCsv]]) {
    const rows = parseInstrumentCsv(broker, "options", csv);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].option, {
      expiryDate: "2026-09-24",
      right: "call",
      strikePrice: 25000,
      lotSize: 25,
    });
    assert.equal(rows[1].option.right, "put");
  }
  assert.throws(
    () =>
      parseInstrumentCsv(
        "kotak",
        "options",
        kotakOptionCsv.replaceAll("nse_fo", "bse_fo"),
      ),
    /segment/,
  );
  assert.throws(
    () =>
      parseInstrumentCsv(
        "kotak",
        "options",
        kotakOptionCsv.replace("lLotSize", "WrongSize"),
      ),
    /columns/,
  );
  assert.throws(
    () =>
      parseInstrumentCsv(
        "kotak",
        "options",
        kotakOptionCsv.replace(",25,", ",0,"),
      ),
    /lot/,
  );
  assert.throws(
    () =>
      parseInstrumentCsv(
        "kotak",
        "options",
        kotakOptionCsv.replaceAll(",2\n", ",4\n"),
      ),
    /units/,
  );
});
test("master discovery URLs cannot forward secrets, redirect to other hosts or accept stale source dates", () => {
  const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10),
    url = `https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/${day}/transformed/nse_fo.csv`;
  assert.equal(validateKotakMasterUrl(url, "options"), url);
  for (const bad of [
    url.replace("lapi.kotaksecurities.com", "evil.test"),
    url + "?token=secret",
    url.replace("https://", "http://"),
    url.replace("https://", "https://secret@"),
    url.replace(day, "2020-01-01"),
    url.replace("nse_fo.csv", "bse_fo.csv"),
  ]) {
    assert.throws(() => validateKotakMasterUrl(bad, "options"));
  }
});
test("catalog search is paged, single-flight, expires safely and rejects tampered selected tickets", async () => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-09-18T05:00Z");
  try {
    const downloads = [],
      catalog = fakeInstrumentCatalog(downloads);
    const url =
      "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/transformed/nse_fo.csv";
    await Promise.all([
      catalog.load("kotak", "options", url),
      catalog.load("kotak", "options", url),
    ]);
    assert.equal(downloads.length, 1);
    const input = instrumentSearchSchema.parse({
        market: "options",
        query: "TEST",
      }),
      result = catalog.search("kotak", input);
    assert.equal(result.total, 2);
    assert.deepEqual(result.expiries, ["2026-09-24"]);
    const item = result.items[0];
    catalog.validate("kotak", item, 25);
    assert.throws(() =>
      catalog.validate(
        "kotak",
        { ...item, masterToken: "other:options:123" },
        25,
      ),
    );
    assert.throws(() =>
      catalog.validate(
        "kotak",
        { ...item, option: { ...item.option, strikePrice: 26000 } },
        25,
      ),
    );
    assert.throws(() => catalog.validate("kotak", item, 26));
    assert.equal(catalog.search("kotak", { ...input, right: "put" }).total, 1);
    assert.equal(
      catalog.search("kotak", { ...input, offset: 50 }).items.length,
      0,
    );
    Date.now = () => Date.parse("2026-09-18T05:16Z");
    assert.throws(() => catalog.validate("kotak", item, 25));
    await catalog.load("kotak", "options", url);
    assert.equal(downloads.length, 2);
  } finally {
    Date.now = realNow;
  }
});
