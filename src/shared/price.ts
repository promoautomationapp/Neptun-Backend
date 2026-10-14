// Uses the reference importer rules for EUR amounts and decimal/thousands separators.
export function parsePrice(input: unknown): number {
  if (typeof input === "number") return Number.isFinite(input) ? input : NaN;
  let raw = String(input ?? "").replace(/(?:EUR|USD|GBP|€|\$|£|\s)/gi, "");
  if (!raw) return NaN;
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma !== -1 && dot !== -1)
    raw =
      comma > dot
        ? raw.replaceAll(".", "").replace(",", ".")
        : raw.replaceAll(",", "");
  else if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, "");
  else if (comma !== -1) raw = raw.replace(",", ".");
  return Number(raw);
}
export function databasePrice(value: unknown): number | null {
  const number = parsePrice(value);
  return Number.isFinite(number) && Math.abs(number) < 1_000_000_000_000
    ? number
    : null;
}
