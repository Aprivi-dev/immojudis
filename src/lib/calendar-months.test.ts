import { describe, expect, it } from "vitest";
import { addUtcCalendarMonths } from "@/lib/calendar-months";

describe("addUtcCalendarMonths", () => {
  it("garde le jour et l'heure, ramenés au dernier jour d'un mois plus court", () => {
    expect(addUtcCalendarMonths(new Date("2026-01-31T10:00:00.000Z"), 1).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(addUtcCalendarMonths(new Date("2026-08-20T12:00:00.000Z"), -36).toISOString()).toBe(
      "2023-08-20T12:00:00.000Z",
    );
  });
});
