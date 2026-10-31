export const CATALOG_AUTOMATIC_INTERVAL_DAYS = 3;
export const CATALOG_TIME_ZONE = "Europe/Belgrade";

function localParts(value: Date | string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CATALOG_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return {
    day: Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000,
    hour: part("hour"),
  };
}

/** Count local calendar days, rather than hours or day-of-month cron steps. */
export function automaticCatalogRefreshDue(
  lastAutomaticAttempt: Date | string | null,
  lastManualSuccess: Date | string | null,
  now = new Date(),
) {
  const today = localParts(now)!;
  const days = [lastAutomaticAttempt, lastManualSuccess]
    .map((value) => (value ? localParts(value)?.day : undefined))
    .filter((day): day is number => day !== undefined);
  return (
    !days.length ||
    today.day - Math.max(...days) >= CATALOG_AUTOMATIC_INTERVAL_DAYS
  );
}

/** A restarted worker catches up only after the normal 03:00 local window. */
export function catalogAutomaticWindowOpen(now = new Date()) {
  return localParts(now)!.hour >= 3;
}
