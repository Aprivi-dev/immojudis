import { describe, expect, it, vi } from "vitest";
import type { RentReference } from "@/lib/rent-reference";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));

import {
  YIELD_AT_STARTING_PRICE_LABEL,
  yieldText,
} from "@/components/sale-detail/RentalMarketBlock";
import { estimateSaleGrossYieldRange } from "@/lib/geo";
import { PUBLIC_YIELD_LABEL, publicRentalYield, publicYieldText } from "./public-rental-yield";

const SALE = {
  id: "sale-1",
  department: "33",
  property_type: "apartment",
  sale_venue_type: "tribunal",
  starting_price_eur: 100_000,
  app_surface_m2: 50,
} as unknown as AuctionSale;

const RELIABLE: RentReference = {
  rentPerM2: 15.9931,
  lowPerM2: 12.272,
  highPerM2: 20.8427,
  source: "anil_commune",
  reliability: "reliable",
  segment: "apt_all",
  communeCode: "33063",
  observations: 84_641,
  vintage: 2025,
  sourceUpdatedOn: "2025-12-11",
};

describe("rendement brut de la fiche publique (calculé par le serveur)", () => {
  it("dit la même chose, avec les mêmes mots, que le bloc « Marché locatif » des comptes", () => {
    expect(PUBLIC_YIELD_LABEL).toBe(YIELD_AT_STARTING_PRICE_LABEL);
    const range = { centralPct: 6, lowPct: 4.5, highPct: 8 };
    for (const reliability of ["reliable", "indicative"] as const) {
      expect(publicYieldText(range, reliability)).toBe(yieldText(range, reliability));
      const noBounds = { ...range, lowPct: null, highPct: null };
      expect(publicYieldText(noBounds, reliability)).toBe(yieldText(noBounds, reliability));
    }
    const computed = estimateSaleGrossYieldRange(SALE, 50, RELIABLE)!;
    expect(publicRentalYield(SALE, RELIABLE)).toBe(yieldText(computed, "reliable"));
    expect(publicRentalYield(SALE, RELIABLE)).toMatch(
      /^\d+,\d % \(de \d+,\d % à \d+,\d % selon la fourchette de loyer\)$/,
    );
  });

  it("ne donne rien sans loyer ANIL, sans mise à prix, sans surface ni régime de frais connu", () => {
    expect(publicRentalYield(SALE, null)).toBeNull();
    expect(publicRentalYield(SALE, { ...RELIABLE, source: "department_estimate" })).toBeNull();
    expect(publicRentalYield({ ...SALE, starting_price_eur: null }, RELIABLE)).toBeNull();
    expect(publicRentalYield({ ...SALE, app_surface_m2: null }, RELIABLE)).toBeNull();
    expect(publicRentalYield({ ...SALE, sale_venue_type: "notary" }, RELIABLE)).toBeNull();
  });
});
