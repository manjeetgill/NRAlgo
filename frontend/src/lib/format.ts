/** Shared INR presentation only. Execution uses integer paise in backend contracts. */
const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});
/** Unknown or invalid monetary values must never be displayed as a zero balance. */
export function formatInr(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? inrFormatter.format(value)
    : "—";
}
