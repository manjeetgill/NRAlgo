/** CSV exports must remain inert when opened in spreadsheet applications. */
import assert from "node:assert/strict";
import test from "node:test";
import { encodeCsv } from "../../frontend/src/lib/download";
test("CSV quotes delimiters and neutralizes formula prefixes without corrupting numeric losses", () => {
  assert.equal(
    encodeCsv([["=SUM(1,2)", 'A"B', -5, null, " @cmd"]]),
    '"\'=SUM(1,2)","A""B","-5","","\' @cmd"',
  );
});
