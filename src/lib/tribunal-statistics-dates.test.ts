import { describe, expect, it } from "vitest";
import {
  addUtcCalendarMonths,
  assertValidDate,
  hasVisitDate,
  hearingCalendar,
} from "@/lib/tribunal-statistics-dates";

describe("hasVisitDate", () => {
  it("lit une date numérique aussi au milieu d'un texte (règle de l'activité judiciaire)", () => {
    expect(hasVisitDate(["22/08/2026"])).toBe(true);
    expect(hasVisitDate(["Visite le 22/08/2026 de 10 h à 12 h"])).toBe(true);
    expect(hasVisitDate(["Visite le 31/02/2026"])).toBe(false);
  });
});

describe("hearingCalendar", () => {
  it("compte les audiences par jour de Paris, avant la fin donnée, dans l'ordre des jours", () => {
    const end = new Date("2026-09-01T00:00:00.000Z");
    expect(
      hearingCalendar(
        [
          new Date("2026-08-21T07:30:00.000Z"),
          new Date("2026-08-20T22:30:00.000Z"),
          new Date("2026-08-20T08:00:00.000Z"),
          new Date("2026-09-02T08:00:00.000Z"),
        ],
        end,
      ),
    ).toEqual([
      { date: "2026-08-20", sales: 1 },
      { date: "2026-08-21", sales: 2 },
    ]);
  });
});

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

describe("assertValidDate", () => {
  it("refuse une date invalide en la nommant", () => {
    expect(() => assertValidDate(new Date("x"), "asOf")).toThrow("asOf must be a valid date.");
    expect(() => assertValidDate(new Date(), "asOf")).not.toThrow();
  });
});
