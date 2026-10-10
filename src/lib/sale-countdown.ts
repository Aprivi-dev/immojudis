import type { AuctionSale } from "./types";
import { parseSaleWindow } from "./sale-window";
import { asRecordOrNull } from "@/lib/guards";

export type SaleCountdownTarget = {
  target: Date | null;
  kind: "window" | "day" | "instant" | "unknown";
  dateOnly?: string;
  deadlineKnown?: boolean;
};

const PARIS_TIME_ZONE = "Europe/Paris";
const DATE_ONLY_PRECISIONS = new Set([
  "day",
  "date",
  "day_only",
  "date_only",
  "unknown_time",
  "time_unknown",
]);

/** Resolve the business deadline used by the countdown, in priority order. */
export function resolveSaleCountdownTarget(
  sale: AuctionSale,
  options: { precisionUnknown?: boolean } = {},
): SaleCountdownTarget | null {
  const procedure = asRecordOrNull(sale.sale_procedure);
  const rawPayload = asRecordOrNull(sale.raw_payload);
  const schedules = [
    procedure?.sale_window,
    procedure?.sale_session,
    rawPayload?.source_sale_schedule,
  ];

  for (const schedule of schedules) {
    const parsed = parseSaleWindow(schedule);
    if (!parsed) continue;
    return { target: new Date(parsed.closes_at), kind: "window" };
  }

  if (!sale.sale_date) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(sale.sale_date) && isoDateUtc(sale.sale_date) == null) return null;
  const rawPrecision = rawPayload?.date_precision ?? rawPayload?.sale_date_precision;
  const rawDate = typeof rawPayload?.sale_date === "string" ? rawPayload.sale_date.trim() : "";
  const saleDate = new Date(sale.sale_date);
  if (!Number.isFinite(saleDate.getTime())) return null;
  const isDayPrecision =
    options.precisionUnknown ||
    (typeof rawPrecision === "string" &&
      DATE_ONLY_PRECISIONS.has(rawPrecision.trim().toLowerCase())) ||
    (rawDate !== "" && !/[0-9]{1,2}\s*([hH]|:[0-9]{2})/.test(rawDate)) ||
    /^\d{4}-\d{2}-\d{2}$/.test(sale.sale_date);

  if (isDayPrecision) {
    const dateOnly = parisDateKey(saleDate);
    return {
      target: nextParisMidnight(dateOnly),
      kind: "day",
      dateOnly,
      deadlineKnown: !options.precisionUnknown,
    };
  }

  return { target: saleDate, kind: "instant" };
}

export function parisDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PARIS_TIME_ZONE,
    year: "numeric",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function calendarDaysBetween(fromDate: string, toDate: string): number | null {
  const from = isoDateUtc(fromDate);
  const to = isoDateUtc(toDate);
  if (from == null || to == null) return null;
  return Math.round((to - from) / 86_400_000);
}

/** Following Paris midnight, including DST transitions. */
export function nextParisMidnight(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const localWallClockAsUtc = Date.UTC(year, month - 1, day + 1);
  const firstGuess = new Date(localWallClockAsUtc);
  const firstOffset = parisOffsetMinutes(firstGuess);
  const firstUtc = localWallClockAsUtc - firstOffset * 60_000;
  const correctedOffset = parisOffsetMinutes(new Date(firstUtc));
  return new Date(localWallClockAsUtc - correctedOffset * 60_000);
}

function isoDateUtc(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const check = new Date(timestamp).toISOString().slice(0, 10);
  return check === value ? timestamp : null;
}

function parisOffsetMinutes(value: Date): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: PARIS_TIME_ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(value)
    .find(({ type }) => type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part ?? "");
  if (!match) throw new Error("Décalage Europe/Paris indisponible.");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}
