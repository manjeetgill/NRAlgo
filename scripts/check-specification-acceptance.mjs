/** Report acceptance coverage without confusing ordinary unit-test success with production sign-off.
 * --strict is a release gate: unresolved requirements or missing product/operations acceptance fail it. */
import { readFileSync } from "node:fs";
const register = JSON.parse(
  readFileSync(
    new URL("../docs/specification-acceptance.json", import.meta.url),
    "utf8",
  ),
);
const accepted = new Set([
  "verified-automated",
  "verified-browser",
  "user-override",
]);
const counts = {};
for (const requirement of register.requirements) {
  counts[requirement.status] = (counts[requirement.status] ?? 0) + 1;
}
console.debug(
  `Source: ${register.source.file} (${register.source.pages} pages)`,
);
console.debug(
  `Numbered requirements: ${register.requirements.length}; named test cases: ${register.requirements.filter((item) => item.id.includes("-T")).length}`,
);
console.debug(JSON.stringify(counts, null, 2));
for (const section of register.sections) {
  const open = register.requirements.filter(
    (item) =>
      item.id.startsWith(section.id + "-") && !accepted.has(item.status),
  );
  console.debug(
    `${section.id} ${section.name}: ${open.length} requirements not accepted`,
  );
}
const unresolvedFlows = register.requirements
  .flatMap((item) => item.checks ?? [])
  .filter((item) => !accepted.has(item.status));
console.debug(
  `Flow success/error checks not accepted: ${unresolvedFlows.length}`,
);
console.debug(
  "Automated model checks do not certify real broker execution, capacity, visual parity or operational readiness.",
);
if (
  process.argv.includes("--strict") &&
  (!register.releaseAccepted ||
    unresolvedFlows.length ||
    register.requirements.some((item) => !accepted.has(item.status)))
) {
  console.error(
    "RELEASE BLOCKED: complete the evidence register and product/operations sign-off first.",
  );
  process.exitCode = 1;
}
