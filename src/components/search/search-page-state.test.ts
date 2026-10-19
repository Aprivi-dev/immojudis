import { describe, expect, it } from "vitest";
import {
  draftNumber,
  draftPrice,
  draftToSearch,
  emptySearchDraft,
  historyModeForDraftChange,
  priceRangeError,
  searchToDraft,
} from "./search-page-state";

describe("saisie des nombres", () => {
  it("ignore une valeur négative ou illisible au lieu de la mettre dans l'adresse", () => {
    expect(draftNumber("-5")).toBeUndefined();
    expect(draftNumber("abc")).toBeUndefined();
    expect(draftNumber("  ")).toBeUndefined();
    expect(draftNumber("60")).toBe(60);
    expect(draftNumber("0")).toBe(0);
  });

  it("plafonne un nombre démesuré : jamais 1e+30 dans l'adresse", () => {
    expect(String(draftNumber("1e30"))).not.toMatch(/e/i);
    expect(draftNumber("1e30")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("plafonne un montant à 100 000 000 € et l'arrondit à l'euro", () => {
    expect(draftPrice("1e30")).toBe(100_000_000);
    expect(draftPrice("250000.4")).toBe(250_000);
    expect(draftPrice("-5")).toBeUndefined();
    expect(draftPrice("")).toBeUndefined();
  });

  it("applique ces règles au brouillon des critères", () => {
    const search = draftToSearch(
      { ...emptySearchDraft(), minPrice: "-5", maxPrice: "1e30", minSqft: "-1", minBeds: "2" },
      {},
    );
    expect(search.minPrice).toBeUndefined();
    expect(search.maxPrice).toBe(100_000_000);
    expect(search.minSqft).toBeUndefined();
    expect(search.minBeds).toBe(2);
  });
});

describe("priceRangeError", () => {
  const range = (minPrice: string, maxPrice: string) => priceRangeError({ minPrice, maxPrice });

  it("dit que la mise à prix minimum dépasse le maximum", () => {
    expect(range("300000", "100000")).toBe("La mise à prix minimum dépasse le maximum");
  });

  it("se tait quand les montants sont cohérents, égaux ou incomplets", () => {
    expect(range("100000", "300000")).toBeNull();
    expect(range("100000", "100000")).toBeNull();
    expect(range("100000", "")).toBeNull();
    expect(range("", "100000")).toBeNull();
    expect(range("abc", "100000")).toBeNull();
  });

  it("compare les montants tels qu'ils seront cherchés (plafonnés)", () => {
    expect(range("1e30", "1e31")).toBeNull();
  });
});

describe("historyModeForDraftChange", () => {
  const base = searchToDraft({});

  it("ajoute une étape à l'historique pour un choix : type de vente, type de bien, case, lieu", () => {
    expect(historyModeForDraftChange(base, { ...base, saleType: "tribunal" })).toBe("push");
    expect(historyModeForDraftChange(base, { ...base, homeTypes: ["house"] })).toBe("push");
    expect(historyModeForDraftChange(base, { ...base, houseWithLand: true })).toBe("push");
    expect(historyModeForDraftChange(base, { ...base, dpeClasses: ["A"] })).toBe("push");
    expect(historyModeForDraftChange(base, { ...base, minSaleDate: "2099-01-01" })).toBe("push");
    expect(historyModeForDraftChange(base, { ...base, city: "Pau", department: "" })).toBe("push");
  });

  it("remplace l'adresse pendant la frappe : montant, surface, mots-clés", () => {
    expect(historyModeForDraftChange(base, { ...base, maxPrice: "1" })).toBe("replace");
    expect(historyModeForDraftChange(base, { ...base, minSqft: "6" })).toBe("replace");
    expect(historyModeForDraftChange(base, { ...base, keywords: "jar" })).toBe("replace");
  });

  it("remplace dès qu'une saisie accompagne un choix, et quand rien n'a changé", () => {
    expect(historyModeForDraftChange(base, { ...base, saleType: "notary", maxPrice: "100" })).toBe(
      "replace",
    );
    expect(historyModeForDraftChange(base, base)).toBe("replace");
  });
});
