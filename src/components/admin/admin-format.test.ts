import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatShortDateTime, queryErrorMessage } from "./admin-format";

// 23:30 UTC le 31 octobre est déjà le 1er novembre à Paris (UTC+1) : le jour et l'heure affichés
// sont ceux de Paris, quel que soit le fuseau du navigateur de l'administrateur.
const LATE_EVENING_UTC = "2026-10-31T23:30:00.000Z";

describe("formats des écrans admin", () => {
  it("affiche date et heure de Paris", () => {
    expect(formatDateTime(LATE_EVENING_UTC)).toBe("1 nov. 2026, 00:30");
    expect(formatDate(LATE_EVENING_UTC)).toBe("1 nov. 2026");
    expect(formatShortDateTime(LATE_EVENING_UTC)).toBe("01/11 00:30");
  });

  it("rend une valeur illisible telle quelle au lieu de faire échouer l'écran", () => {
    expect(formatDateTime("pas une date")).toBe("pas une date");
    expect(formatDate("")).toBe("");
  });

  it("garde le message d'une erreur, sinon le texte de repli", () => {
    expect(queryErrorMessage(new Error("Session expirée"), "Chargement impossible")).toBe(
      "Session expirée",
    );
    expect(queryErrorMessage(new Error(""), "Chargement impossible")).toBe("Chargement impossible");
    expect(queryErrorMessage("échec", "Chargement impossible")).toBe("Chargement impossible");
  });
});
