export function normalizeSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
export function searchWords(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z]+|[0-9]+/g) ?? []
  );
}
export function isPhoneQuery(value: string): boolean {
  return /^(phone|phones|telefon|telefona|telefoni|smartphone|smartphones)$/.test(
    normalizeSearch(value),
  );
}
