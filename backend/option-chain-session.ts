/** Display-data schedule only, never authorization to execute orders.
 * 2026 closures: NSE/CMTR/71775 and NSE/CMTR/72260. Operators must maintain
 * closures and special sessions as new exchange notices are published.
 */
const closures2026 = new Set([
  "2026-01-15",
  "2026-01-26",
  "2026-03-03",
  "2026-03-26",
  "2026-03-31",
  "2026-04-03",
  "2026-04-14",
  "2026-05-01",
  "2026-05-28",
  "2026-06-26",
  "2026-09-14",
  "2026-10-02",
  "2026-10-20",
  "2026-11-10",
  "2026-11-24",
  "2026-12-25",
]);
export function optionChainSessionOpen(
  now: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const ist = new Date(now + 19800000);
  const day = ist.toISOString().slice(0, 10);
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Explicit date=HH:MM-HH:MM overrides support notified weekend/Muhurat sessions.
  const special = (env.NSE_SPECIAL_SESSIONS || "")
    .split(",")
    .find((value) => value.trim().startsWith(`${day}=`));
  if (special) {
    const match = special
      .trim()
      .match(/^\d{4}-\d{2}-\d{2}=(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!match) {
      return false;
    }
    const [h1, m1, h2, m2] = match.slice(1).map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) {
      return false;
    }
    return minute >= h1 * 60 + m1 && minute < h2 * 60 + m2;
  }
  if (
    closures2026.has(day) ||
    (env.NSE_CLOSED_DATES || "")
      .split(",")
      .map((value) => value.trim())
      .includes(day)
  ) {
    return false;
  }
  return (
    ist.getUTCDay() > 0 && ist.getUTCDay() < 6 && minute >= 555 && minute < 930
  );
}
