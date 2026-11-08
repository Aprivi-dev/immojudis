import { describe, expect, it, vi } from "vitest";
import type { RentReference } from "@/lib/rent-reference";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));

import {
  YIELD_AT_STARTING_PRICE_LABEL,
  yieldText,
} from "@/components/sale-detail/RentalMarketBlock";
import { estimateSaleGrossYieldRange } from "@/lib/geo";
import {
  PUBLIC_YIELD_LABEL,
  PUBLIC_YIELD_NOT_SIGNIFICANT_NOTE,
  PUBLIC_YIELD_SIGNIFICANCE_MAX_PCT,
  publicRentalYield,
  publicRentalYieldFromRange,
  publicYieldText,
} from "./public-rental-yield";

/** Espaces insécables du format français remplacées par des espaces simples. */
const plain = (value: string | undefined) => (value ?? "").replace(/[\u202f\u00a0]/g, " ");

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
    expect(publicRentalYield(SALE, RELIABLE)).toEqual({
      kind: "yield",
      text: yieldText(computed, "reliable"),
    });
    expect(publicRentalYield(SALE, RELIABLE)?.text).toMatch(
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

describe("rendement à la mise à prix invraisemblable (P6)", () => {
  const INDICATIVE: RentReference = { ...RELIABLE, reliability: "indicative" };

  it("fixe le seuil à 15 %", () => {
    expect(PUBLIC_YIELD_SIGNIFICANCE_MAX_PCT).toBe(15);
  });

  it("dit que le prix final est souvent bien plus élevé, sans le promettre", () => {
    expect(PUBLIC_YIELD_NOT_SIGNIFICANT_NOTE).toBe(
      "Rendement non significatif à la mise à prix : le prix final est souvent bien plus élevé.",
    );
  });

  it("garde le rendement sous le seuil et au seuil exactement", () => {
    const below = { centralPct: 9, lowPct: 7, highPct: 14.9 };
    expect(publicRentalYieldFromRange(below, RELIABLE, 50)).toEqual({
      kind: "yield",
      text: "9,0 % (de 7,0 % à 14,9 % selon la fourchette de loyer)",
    });
    const atThreshold = { centralPct: 12, lowPct: 9, highPct: 15 };
    expect(publicRentalYieldFromRange(atThreshold, RELIABLE, 50)).toEqual({
      kind: "yield",
      text: "12,0 % (de 9,0 % à 15,0 % selon la fourchette de loyer)",
    });
    expect(publicRentalYieldFromRange(atThreshold, INDICATIVE, 50)).toEqual({
      kind: "yield",
      text: "entre 9,0 % et 15,0 %",
    });
    const centralOnly = { centralPct: 15, lowPct: null, highPct: null };
    expect(publicRentalYieldFromRange(centralOnly, RELIABLE, 50)?.kind).toBe("yield");
  });

  it("au-dessus du seuil, donne le loyer mensuel estimé, avec la même règle que le rendement", () => {
    const above = { centralPct: 12, lowPct: 9, highPct: 15.1 };
    const reliable = publicRentalYieldFromRange(above, RELIABLE, 50);
    expect(reliable?.kind).toBe("rent");
    // 50 m² × 15,99 €/m² = 800 € ; fourchette 613,6 € et 1 042,1 €, arrondis à la dizaine.
    expect(plain(reliable?.text)).toBe("800 € (de 610 € à 1 040 € selon la fourchette de loyer)");

    const indicative = publicRentalYieldFromRange(
      { centralPct: 60, lowPct: 41.5, highPct: 80.3 },
      INDICATIVE,
      50,
    );
    expect(indicative?.kind).toBe("rent");
    expect(plain(indicative?.text)).toBe("entre 610 € et 1 040 €");

    const noBounds = { ...RELIABLE, lowPerM2: null, highPerM2: null };
    const central = { centralPct: 40, lowPct: null, highPct: null };
    expect(plain(publicRentalYieldFromRange(central, noBounds, 50)?.text)).toBe("800 €");
  });

  it("remplace le rendement d'une mise à prix très basse par le loyer, calculé par le serveur", () => {
    const cheap = { ...SALE, starting_price_eur: 10_000 };
    expect(estimateSaleGrossYieldRange(cheap, 50, RELIABLE)!.highPct!).toBeGreaterThan(15);
    const result = publicRentalYield(cheap, RELIABLE);
    expect(result?.kind).toBe("rent");
    expect(plain(result?.text)).toBe("800 € (de 610 € à 1 040 € selon la fourchette de loyer)");
    expect(result?.text).not.toContain("%");
  });

  it("ne donne rien quand le loyer est indisponible", () => {
    const cheap = { ...SALE, starting_price_eur: 10_000 };
    expect(publicRentalYield(cheap, null)).toBeNull();
    expect(publicRentalYield(cheap, { ...RELIABLE, source: "department_estimate" })).toBeNull();
    expect(publicRentalYield({ ...cheap, app_surface_m2: null }, RELIABLE)).toBeNull();
    const indicativeNoBounds = { ...INDICATIVE, lowPerM2: null, highPerM2: null };
    expect(
      publicRentalYieldFromRange(
        { centralPct: 40, lowPct: null, highPct: null },
        indicativeNoBounds,
        50,
      ),
    ).toBeNull();
    expect(
      publicRentalYieldFromRange({ centralPct: 40, lowPct: 30, highPct: 50 }, INDICATIVE, 0),
    ).toBeNull();
  });
});
