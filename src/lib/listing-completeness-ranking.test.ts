import { describe, expect, it } from "vitest";
import {
  COMPLETENESS_TIER_HIGH,
  COMPLETENESS_TIER_LOW,
  LISTING_COMPLETENESS_POLICY,
  completenessTierForClassification,
  isWellInformedSale,
} from "./listing-completeness-ranking";
import { getListingCompleteness } from "./listing-completeness";
import type { AuctionSale } from "./types";

describe("règle de palier de complétude", () => {
  it("garde les classifications « décision prête » et « riche » de la fiche, dans une constante unique", () => {
    expect(LISTING_COMPLETENESS_POLICY).toEqual({
      version: "completeness-tier-v1",
      highTierClassifications: ["decision_prete", "riche"],
    });
  });

  it("n'a que deux paliers: haut pour « décision prête » et « riche », bas pour le reste", () => {
    expect(completenessTierForClassification("decision_prete")).toBe(COMPLETENESS_TIER_HIGH);
    expect(completenessTierForClassification("riche")).toBe(COMPLETENESS_TIER_HIGH);
    expect(completenessTierForClassification("a_enrichir")).toBe(COMPLETENESS_TIER_LOW);
    expect(completenessTierForClassification("incomplet")).toBe(COMPLETENESS_TIER_LOW);
  });

  it("met dans le palier bas ce qui n'est pas mesuré", () => {
    expect(completenessTierForClassification(null)).toBe(COMPLETENESS_TIER_LOW);
    expect(completenessTierForClassification(undefined)).toBe(COMPLETENESS_TIER_LOW);
  });

  it("suit la classification publiée de la fiche, pas le score brut", () => {
    // Une fiche vide: la classification publiée est « incomplet », donc palier bas.
    const result = getListingCompleteness({ id: "empty" } as AuctionSale);
    expect(result.classification).toBe("incomplet");
    expect(completenessTierForClassification(result.classification)).toBe(COMPLETENESS_TIER_LOW);
    // La classification publiée ne dépasse jamais « a_enrichir » quand une porte critique échoue,
    // même si le score brut atteint « décision prête » : le palier reste bas.
    expect(completenessTierForClassification("a_enrichir")).toBe(COMPLETENESS_TIER_LOW);
    expect(result.rawClassification).toBeDefined();
  });

  it("ne reconnaît une annonce bien renseignée que dans le palier haut", () => {
    expect(isWellInformedSale({ completeness_tier: 1 })).toBe(true);
    expect(isWellInformedSale({ completeness_tier: 0 })).toBe(false);
    expect(isWellInformedSale({ completeness_tier: null })).toBe(false);
    expect(isWellInformedSale({})).toBe(false);
  });
});
