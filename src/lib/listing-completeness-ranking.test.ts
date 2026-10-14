import { describe, expect, it } from "vitest";
import {
  COMPLETENESS_TIER_HIGH,
  COMPLETENESS_TIER_LOW,
  LISTING_COMPLETENESS_POLICY,
  completenessTierForScore,
  isWellInformedSale,
} from "./listing-completeness-ranking";
import { getListingCompleteness } from "./listing-completeness";
import type { AuctionSale } from "./types";

describe("règle de palier de complétude", () => {
  it("garde le seuil de score et la version de la règle dans une constante unique", () => {
    expect(LISTING_COMPLETENESS_POLICY).toEqual({
      version: "completeness-tier-v2",
      highTierMinScore: 40,
    });
  });

  it("n'a que deux paliers: haut à partir de 40 sur 100, bas en dessous", () => {
    expect(completenessTierForScore(39.9)).toBe(COMPLETENESS_TIER_LOW);
    expect(completenessTierForScore(40)).toBe(COMPLETENESS_TIER_HIGH);
    expect(completenessTierForScore(40.1)).toBe(COMPLETENESS_TIER_HIGH);
    expect(completenessTierForScore(71)).toBe(COMPLETENESS_TIER_HIGH);
    expect(completenessTierForScore(100)).toBe(COMPLETENESS_TIER_HIGH);
    expect(completenessTierForScore(0)).toBe(COMPLETENESS_TIER_LOW);
  });

  it("met dans le palier bas ce qui n'est pas mesuré ou invalide", () => {
    expect(completenessTierForScore(null)).toBe(COMPLETENESS_TIER_LOW);
    expect(completenessTierForScore(undefined)).toBe(COMPLETENESS_TIER_LOW);
    expect(completenessTierForScore(Number.NaN)).toBe(COMPLETENESS_TIER_LOW);
    expect(completenessTierForScore(Number.POSITIVE_INFINITY)).toBe(COMPLETENESS_TIER_LOW);
    expect(completenessTierForScore(100.1)).toBe(COMPLETENESS_TIER_LOW);
  });

  it("suit le score de la fiche, pas sa classification publiée", () => {
    // Une fiche vide: score nul, donc palier bas.
    const empty = getListingCompleteness({ id: "empty" } as AuctionSale);
    expect(completenessTierForScore(empty.score)).toBe(COMPLETENESS_TIER_LOW);
    // La classification « à enrichir » (score 55 à 75) ou « incomplet » (en dessous de 55) ne
    // retire pas le palier haut à partir de 40: seul le score compte.
    expect(completenessTierForScore(45)).toBe(COMPLETENESS_TIER_HIGH);
  });

  it("ne reconnaît une annonce bien renseignée que dans le palier haut", () => {
    expect(isWellInformedSale({ completeness_tier: 1 })).toBe(true);
    expect(isWellInformedSale({ completeness_tier: 0 })).toBe(false);
    expect(isWellInformedSale({ completeness_tier: null })).toBe(false);
    expect(isWellInformedSale({})).toBe(false);
  });
});
