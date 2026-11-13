import type { AuctionSale } from "./types";
import { addDays, isCalendarDay } from "@/lib/calendar-day";
import { parseSaleWindow } from "./sale-window";
import { asRecordOrNull } from "@/lib/guards";
import { parisDateKey, parisMidnightUtc } from "@/lib/paris-time";

export type SaleCountdownTarget = {
  target: Date | null;
  kind: "window" | "day" | "instant" | "unknown";
  dateOnly?: string;
  deadlineKnown?: boolean;
};

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
  if (/^\d{4}-\d{2}-\d{2}$/.test(sale.sale_date) && !isCalendarDay(sale.sale_date)) return null;
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

/** Following Paris midnight, including DST transitions. */
export function nextParisMidnight(dateOnly: string): Date {
  return parisMidnightUtc(addDays(dateOnly, 1));
}
