import { addDays, validCalendarDay } from "@/lib/calendar-day";
import { parisMidnightUtc } from "@/lib/paris-time";

// Auction calendar days are interpreted in metropolitan France, including DST.
export function saleDateBoundary(value: string, end = false): string {
  const date = validCalendarDay(value);
  if (!date) throw new Error("Invalid sale date");
  if (!end) return parisMidnightUtc(date).toISOString();
  return new Date(parisMidnightUtc(addDays(date, 1)).getTime() - 1).toISOString();
}
