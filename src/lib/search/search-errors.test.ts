import { describe, expect, it } from "vitest";
import {
  OUT_OF_RANGE_MESSAGE,
  SearchRejectedError,
  isOutOfRangeSearchError,
} from "./search-errors";

describe("SearchRejectedError", () => {
  it("dit en français une page hors bornes, quel que soit le texte de la route", () => {
    for (const message of ["Page hors limites.", "Paramètre « page » invalide.", ""]) {
      const error = new SearchRejectedError(message, true);
      expect(error.outOfRange).toBe(true);
      expect(error.message).toBe(OUT_OF_RANGE_MESSAGE);
      expect(error.status).toBe(400);
      expect(isOutOfRangeSearchError(error)).toBe(true);
    }
  });

  it("garde le message de la route pour un autre refus, sans le dire hors bornes", () => {
    // Le texte de la route ne décide plus : seul le calcul de la page le fait.
    expect(new SearchRejectedError("Page hors limites.").outOfRange).toBe(false);
    const error = new SearchRejectedError("Zone trop large.", false);
    expect(error.outOfRange).toBe(false);
    expect(error.message).toBe("Zone trop large.");
    expect(isOutOfRangeSearchError(error)).toBe(false);
    expect(new SearchRejectedError("").message).toBe("Cette recherche n’est pas valide.");
  });

  it("ne prend pas une panne pour un refus", () => {
    expect(isOutOfRangeSearchError(new Error("Page hors limites."))).toBe(false);
    expect(isOutOfRangeSearchError(null)).toBe(false);
  });
});
