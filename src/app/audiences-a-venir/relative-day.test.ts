import { describe, expect, it } from "vitest";
import { calendarDaysBetween, parisDateKey } from "@/lib/sale-countdown";
import { daysBetween, parisDay } from "./relative-day";

describe("calcul du jour de RelativeDay", () => {
  it("donne le même jour à Paris que sale-countdown, y compris autour de minuit et du changement d'heure", () => {
    const instants = [
      "2026-10-20T08:00:00Z",
      "2026-10-19T21:59:59Z",
      "2026-10-19T22:00:00Z",
      "2026-03-28T23:30:00Z",
      "2026-03-29T00:30:00Z",
      "2026-10-24T22:30:00Z",
      "2026-10-25T23:30:00Z",
      "2026-12-31T23:30:00Z",
    ];
    for (const instant of instants) {
      expect(parisDay(new Date(instant))).toBe(parisDateKey(new Date(instant)));
    }
  });

  it("compte les jours calendaires comme sale-countdown, et refuse une date illisible", () => {
    const pairs: [string, string][] = [
      ["2026-10-20", "2026-10-20"],
      ["2026-10-20", "2026-10-21"],
      ["2026-10-24", "2026-10-26"],
      ["2026-12-30", "2027-01-02"],
      ["2026-10-20", "2026-10-19"],
    ];
    for (const [from, to] of pairs) {
      expect(daysBetween(from, to)).toBe(calendarDaysBetween(from, to));
    }
    expect(daysBetween("2026-10-20", "demain")).toBeNull();
    expect(daysBetween("", "2026-10-20")).toBeNull();
  });
});
