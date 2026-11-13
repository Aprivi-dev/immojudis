import {
  isPastParisDay,
  parisDateKey,
  parisDateKeyOrNull,
  parisMidnightUtc,
  startOfParisDay,
} from "./paris-time";
import { describe, expect, it } from "vitest";
import { addDays, calendarDaysBetween, isCalendarDay } from "./calendar-day";

describe("jour civil à Paris", () => {
  it.each([
    ["2026-10-20T08:00:00Z", "2026-10-20"],
    ["2026-10-19T21:59:59Z", "2026-10-19"],
    ["2026-10-19T22:00:00Z", "2026-10-20"],
    ["2026-03-28T23:30:00Z", "2026-03-29"],
    ["2026-10-24T22:30:00Z", "2026-10-25"],
    ["2026-12-31T23:30:00Z", "2027-01-01"],
  ])("%s → %s", (instant, day) => {
    expect(parisDateKey(new Date(instant))).toBe(day);
    expect(parisDateKeyOrNull(instant)).toBe(day);
  });

  it("refuse une valeur qui n'est pas une date", () => {
    expect(parisDateKeyOrNull("pas une date")).toBeNull();
    expect(parisDateKeyOrNull("")).toBeNull();
    expect(parisDateKeyOrNull(null)).toBeNull();
  });

  it("passe au jour suivant à minuit de Paris, pas d'UTC, heure d'été comprise", () => {
    expect(parisDateKey(new Date("2026-07-14T21:59:59Z"))).toBe("2026-07-14");
    expect(parisDateKey(new Date("2026-07-14T22:00:00Z"))).toBe("2026-07-15");
    expect(parisDateKey(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});

describe("calcul sur les jours civils", () => {
  it("compte les jours civils et refuse un jour qui n'existe pas", () => {
    expect(calendarDaysBetween("2026-10-20", "2026-10-20")).toBe(0);
    expect(calendarDaysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(calendarDaysBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(calendarDaysBetween("2026-10-20", "2026-10-19")).toBe(-1);
    expect(calendarDaysBetween("2026-02-30", "2026-03-01")).toBeNull();
    expect(calendarDaysBetween("2026-10-20", "demain")).toBeNull();
  });

  it("ajoute des jours par-delà les mois, les années et le changement d'heure", () => {
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("reconnaît un jour du calendrier écrit AAAA-MM-JJ", () => {
    expect(isCalendarDay("2028-02-29")).toBe(true);
    for (const value of ["2026-02-30", "bad", "2026-9-1", "2026-09-11T00:00:00Z", 20260911, null]) {
      expect(isCalendarDay(value), String(value)).toBe(false);
    }
  });
});

describe("minuit de Paris en UTC", () => {
  it.each([
    ["2026-01-15", "2026-01-14T23:00:00.000Z"],
    ["2026-07-15", "2026-07-14T22:00:00.000Z"],
    // Passage à l'heure d'été (29/03/2026, à 2 h) : minuit est encore à UTC+1.
    ["2026-03-29", "2026-03-28T23:00:00.000Z"],
    ["2026-03-30", "2026-03-29T22:00:00.000Z"],
    // Passage à l'heure d'hiver (25/10/2026, à 3 h) : minuit est encore à UTC+2.
    ["2026-10-25", "2026-10-24T22:00:00.000Z"],
    ["2026-10-26", "2026-10-25T23:00:00.000Z"],
  ])("%s → %s", (day, instant) => {
    expect(parisMidnightUtc(day).toISOString()).toBe(instant);
  });

  it("donne le début du jour de Paris qui contient l'instant", () => {
    expect(startOfParisDay(new Date("2026-03-29T21:30:00Z")).toISOString()).toBe(
      "2026-03-28T23:00:00.000Z",
    );
    expect(startOfParisDay(new Date("2026-10-25T23:00:00Z")).toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
  });
});

describe("date passée", () => {
  const now = new Date("2026-10-19T10:00:00Z"); // 12 h à Paris.

  it("est passée quand son jour, à Paris, est avant celui de maintenant", () => {
    expect(isPastParisDay("2026-10-18T12:00:00Z", now)).toBe(true);
    // 23 h 30 UTC le 18 = 1 h 30 le 19 à Paris : aujourd'hui.
    expect(isPastParisDay("2026-10-18T23:30:00Z", now)).toBe(false);
  });

  it("ne dit pas passée une audience d'aujourd'hui, avant comme après son heure", () => {
    expect(isPastParisDay("2026-10-19T12:00:00Z", now)).toBe(false);
    expect(isPastParisDay("2026-10-19T07:00:00Z", now)).toBe(false);
  });

  it("ne dit rien d'une date absente ou illisible", () => {
    expect(isPastParisDay(null, now)).toBe(false);
    expect(isPastParisDay("bientôt", now)).toBe(false);
  });
});
