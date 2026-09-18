/** Browser-owned downloads; data never leaves this origin and temporary object URLs are released. */
export function downloadText(
  filename: string,
  contents: string,
  mime = "text/plain",
) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: `${mime};charset=utf-8` }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Quote CSV cells and neutralize spreadsheet formulas in exported untrusted text. */
export function encodeCsv(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text =
            value === null || value === undefined ? "" : String(value);
          const safe =
            typeof value === "string" && /^[\s]*[=+@\-\t\r]/.test(text)
              ? `'${text}`
              : text;
          return `"${safe.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
