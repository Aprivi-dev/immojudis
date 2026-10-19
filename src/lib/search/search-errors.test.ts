import { describe, expect, it } from "vitest";
import {
  OUT_OF_RANGE_MESSAGE,
  SearchRejectedError,
  isOutOfRangeSearchError,
  retrySearch,
} from "./search-errors";

describe("SearchRejectedError", () => {
  it("reconnaît une page ou une taille de page hors bornes et la dit en français", () => {
    for (const message of ["Page hors limites.", "Taille de page invalide."]) {
      const error = new SearchRejectedError(message);
      expect(error.outOfRange).toBe(true);
      expect(error.message).toBe(OUT_OF_RANGE_MESSAGE);
      expect(error.status).toBe(400);
      expect(isOutOfRangeSearchError(error)).toBe(true);
    }
  });

  it("garde le message de la route pour un autre refus, sans le dire hors bornes", () => {
    const error = new SearchRejectedError("Zone trop large.");
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

describe("retrySearch", () => {
  it("retente une panne une fois", () => {
    expect(retrySearch(0, new Error("réseau"))).toBe(true);
    expect(retrySearch(1, new Error("réseau"))).toBe(false);
  });

  it("ne rejoue jamais une demande refusée : la réponse serait la même", () => {
    expect(retrySearch(0, new SearchRejectedError("Page hors limites."))).toBe(false);
    expect(retrySearch(0, new SearchRejectedError("Zone trop large."))).toBe(false);
  });
});
