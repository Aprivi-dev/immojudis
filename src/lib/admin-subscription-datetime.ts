const DATE_TIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Format a UTC date for an HTML datetime-local input in the browser's local time. */
export function formatDateTimeLocalInput(
  date: Date,
  timezoneOffsetMinutes = date.getTimezoneOffset(),
): string {
  if (Number.isNaN(date.getTime())) return "";

  const localDate = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
  return localDate.toISOString().slice(0, 16);
}

/** Convert an HTML datetime-local value to the UTC ISO representation used by the API. */
export function dateTimeLocalToUtcIso(
  value: string,
  timezoneOffsetMinutes?: number,
): string | undefined {
  const match = DATE_TIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) return undefined;

  const [, year, month, day, hour, minute] = match;
  if (timezoneOffsetMinutes === undefined) {
    const localDate = new Date(value);
    return Number.isNaN(localDate.getTime()) ? undefined : localDate.toISOString();
  }

  const utcTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  const utcDate = new Date(utcTime + timezoneOffsetMinutes * 60_000);
  return Number.isNaN(utcDate.getTime()) ? undefined : utcDate.toISOString();
}
