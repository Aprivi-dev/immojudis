import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatNumericDate,
  formatNumericDateTime,
  formatShortDate,
  formatShortDateTime,
} from "./dates";

describe("dates affichées à l'heure de Paris", () => {
  const instant = "2026-11-05T13:30:00.000Z";

  it("donne chaque variante une fois", () => {
    expect(formatDate(instant)).toBe("5 novembre 2026");
    expect(formatDateTime(instant)).toBe("5 novembre 2026 à 14:30");
    expect(formatShortDate(instant)).toBe("5 nov. 2026");
    expect(formatShortDateTime(instant)).toBe("5 nov. 2026, 14:30");
    expect(formatNumericDate(instant)).toBe("05/11/2026");
    expect(formatNumericDateTime(instant)).toBe("05/11/2026 14:30");
    expect(formatDayMonth(instant)).toBe("5 nov.");
  });

  it("passe au lendemain à minuit de Paris, pas à minuit UTC", () => {
    // Hiver (UTC+1) : 22 h 30 UTC est encore la veille à Paris, 23 h 30 UTC déjà le lendemain.
    expect(formatNumericDateTime("2026-01-15T22:30:00.000Z")).toBe("15/01/2026 23:30");
    expect(formatNumericDateTime("2026-01-15T23:30:00.000Z")).toBe("16/01/2026 00:30");
    expect(formatDate("2026-12-31T23:30:00.000Z")).toBe("1 janvier 2027");
    // Été (UTC+2) : 22 h 30 UTC est déjà le lendemain à Paris.
    expect(formatShortDate("2026-07-14T22:30:00.000Z")).toBe("15 juil. 2026");
    expect(formatDayMonth("2026-07-14T22:30:00.000Z")).toBe("15 juil.");
  });

  it("suit les changements d'heure", () => {
    // 29 mars 2026 : 2 h devient 3 h à Paris (1 h UTC).
    expect(formatNumericDateTime("2026-03-29T00:30:00.000Z")).toBe("29/03/2026 01:30");
    expect(formatNumericDateTime("2026-03-29T01:30:00.000Z")).toBe("29/03/2026 03:30");
    // 25 octobre 2026 : 3 h redevient 2 h à Paris ; 2 h 30 existe deux fois.
    expect(formatNumericDateTime("2026-10-25T00:30:00.000Z")).toBe("25/10/2026 02:30");
    expect(formatNumericDateTime("2026-10-25T01:30:00.000Z")).toBe("25/10/2026 02:30");
    expect(formatShortDateTime("2026-10-25T22:30:00.000Z")).toBe("25 oct. 2026, 23:30");
  });

  it("ne décale jamais un jour civil AAAA-MM-JJ", () => {
    expect(formatDate("2026-03-05")).toBe("5 mars 2026");
    expect(formatDate("2026-01-01")).toBe("1 janvier 2026");
    expect(formatShortDate("2026-03-29")).toBe("29 mars 2026");
    expect(formatNumericDate("2026-10-25")).toBe("25/10/2026");
    expect(formatNumericDate("2026-12-31")).toBe("31/12/2026");
  });

  it("rend le texte de repli pour une valeur absente ou illisible", () => {
    expect(formatDate(null)).toBe("Date à confirmer");
    expect(formatDate("pas une date")).toBe("Date à confirmer");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatShortDate("")).toBe("—");
    expect(formatShortDateTime("pas une date", "date illisible")).toBe("date illisible");
    expect(formatNumericDate(null, "")).toBe("");
    expect(formatNumericDateTime("pas une date", "Non établie")).toBe("Non établie");
    expect(formatDayMonth(null)).toBe("—");
  });
});
