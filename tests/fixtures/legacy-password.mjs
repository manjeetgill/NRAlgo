/** Previous password encoding for migration regression fixtures only. */
import { scryptSync } from "node:crypto";
export function hashPasswordForLegacyCompatibility(password, salt) {
  return (
    salt +
    ":" +
    scryptSync(password, Buffer.from(salt, "hex"), 64, {
      N: 16384,
      r: 8,
      p: 1,
    }).toString("hex")
  );
}
