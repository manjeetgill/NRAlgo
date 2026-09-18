/** Ensure no named PDF obligation can disappear or acquire an evidence-free green status. */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
const register = JSON.parse(
  readFileSync("docs/specification-acceptance.json", "utf8"),
);
test("acceptance register retains all 262 requirement IDs, 104 cases and 186 flow branches", () => {
  assert.equal(
    register.source.sha256,
    "7f4c317fdc4c7445afc2a2d4fec86c78c5337c9d5d7ce9ed687c8c6ead7dc91c",
  );
  assert.equal(register.requirements.length, 262);
  assert.equal(new Set(register.requirements.map((item) => item.id)).size, 262);
  assert.equal(
    register.requirements.filter((item) => item.id.includes("-T")).length,
    104,
  );
  assert.equal(
    register.requirements.flatMap((item) => item.checks ?? []).length,
    186,
  );
  const statuses = new Set([
    "open",
    "partial",
    "verified-automated",
    "verified-browser",
    "user-override",
  ]);
  for (const item of register.requirements) {
    assert.match(item.id, /^(SH|0[1-9]|1[0-3])-[DFT]\d{2}$/);
    assert.ok(item.page >= 1 && item.page <= 215);
    assert.ok(statuses.has(item.status));
    assert.ok(item.note.trim().length > 10);
    for (const path of item.evidence) {
      assert.ok(existsSync(path), `${item.id}: missing evidence ${path}`);
    }
    if (item.status.startsWith("verified-")) {
      assert.ok(item.evidence.length > 0, `${item.id}: no evidence`);
    }
    if (item.status === "verified-automated") {
      assert.ok(
        item.evidence.some(
          (path) =>
            path.startsWith("tests/") &&
            readFileSync(path, "utf8").includes(item.id),
        ),
        `${item.id}: missing named regression`,
      );
    }
    if (item.id.includes("-F")) {
      assert.deepEqual(
        item.checks.map((check) => check.id),
        [item.id + "-S", item.id + "-E"],
      );
    }
  }
});
