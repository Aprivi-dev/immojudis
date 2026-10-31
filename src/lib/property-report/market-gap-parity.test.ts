import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { DEFAULT_OPEN_FEE_REGIMES } from "@/lib/fee-regime-open";
import type { MarketEstimate } from "@/lib/market.server";
import { MARKET_GAP_WITHHELD_OCCUPIED } from "@/lib/market-gap";
import { buildValuePreview } from "@/lib/value-preview";
import { buildCeilingSnapshot, buildOpportunityAnalysis } from "./analysis";
import { deriveOpportunityScore } from "./serialization";

const SURFACE = 80;

/** Estimation à 2 000 €/m² sur 80 m² : valeur 160 000 €. */
function estimate(): MarketEstimate {
  return {
    actionable: true,
    medianPricePerM2: 2_000,
    p25PricePerM2: 1_800,
    p75PricePerM2: 2_300,
    estimatedValueEur: 160_000,
    estimatedValueLowEur: 140_000,
    estimatedValueHighEur: 180_000,
    subjectSurfaceM2: SURFACE,
    qualityLabel: "correcte",
  } as unknown as MarketEstimate;
}

function reportOpportunity(startingPrice: number | null, occupancyStatus: string | null) {
  const sale = {
    ...EXAMPLE_SALE,
    department: "33",
    starting_price_eur: startingPrice,
    app_surface_m2: SURFACE,
    app_surface_kind: "habitable" as const,
    occupancy_status: occupancyStatus,
  };
  return buildOpportunityAnalysis({
    sale,
    surfaceM2: SURFACE,
    marketEstimate: estimate(),
    ceilingSnapshot: buildCeilingSnapshot(sale, null, {}, DEFAULT_OPEN_FEE_REGIMES, null),
  });
}

describe("décote du rapport et de la fiche", () => {
  it.each([
    [100_000, "vacant"],
    [120_000, "libre"],
    [160_000, "inoccupé"],
    [180_000, "vacant"],
    [30_000, "vacant"],
    [10_000, "vacant"],
    [400_000, "vacant"],
    [100_000, "occupied"],
    [100_000, "tenant_occupied"],
    [100_000, "squatted"],
    [100_000, "unknown"],
    [100_000, null],
  ])("mise à prix %s, occupation %s : même décote que la fiche", (price, occupancy) => {
    const preview = buildValuePreview(estimate(), price, occupancy);
    const opportunity = reportOpportunity(price, occupancy);

    expect(opportunity.apparentDiscountPct).toBe(preview.discountPct);
  });

  it("donne une décote entière, comme la fiche", () => {
    // (160 000 - 103 333) / 160 000 = 35,4 % : la fiche affiche 35, jamais 35,4.
    const opportunity = reportOpportunity(103_333, "vacant");
    expect(opportunity.apparentDiscountPct).toBe(35);
    expect(Number.isInteger(opportunity.apparentDiscountPct)).toBe(true);
  });

  it("ne donne aucun pourcentage hors des bornes de market-gap, mais le dit", () => {
    // 10 000 € pour 160 000 € de valeur : 94 % de décote, hors de la plage où le chiffre a un sens.
    const opportunity = reportOpportunity(10_000, "vacant");

    expect(opportunity.apparentDiscountPct).toBeNull();
    expect(opportunity.apparentDiscountNote).toContain("Écart non significatif");
    expect(opportunity.summary).not.toContain("décote apparente");
  });

  it("masque la décote d'un bien occupé et le dit", () => {
    const opportunity = reportOpportunity(100_000, "occupied");

    expect(opportunity.apparentDiscountPct).toBeNull();
    expect(opportunity.apparentDiscountNote).toBe(MARKET_GAP_WITHHELD_OCCUPIED);
  });

  it("ne dit rien d'une décote sans mise à prix", () => {
    const opportunity = reportOpportunity(null, "vacant");

    expect(opportunity.apparentDiscountPct).toBeNull();
    expect(opportunity.apparentDiscountNote).toBeNull();
  });

  it("sans mise à prix : ni coût complet, ni rendement, ni marge « à 0 € »", () => {
    const opportunity = reportOpportunity(null, "vacant");

    expect(opportunity.rentabilityScore).toMatchObject({
      available: false,
      reason: "Prix manquant",
      grossYieldPct: null,
    });
    expect(opportunity.acquisitionCosts).toMatchObject({
      price: null,
      totalCost: null,
      acquisitionFeesTotal: null,
      totalCostPerM2: null,
    });
    expect(opportunity.bidCeiling.marginTotal).toBeNull();
  });

  it("le score d'opportunité ne reçoit plus la décote d'un bien occupé ou aberrante", () => {
    const occupied = reportOpportunity(100_000, "occupied");
    const absurd = reportOpportunity(10_000, "vacant");
    const ceiling = { available: false } as Parameters<
      typeof deriveOpportunityScore
    >[0]["ceilingSnapshot"];
    const score = (apparentDiscountPct: number | null) =>
      deriveOpportunityScore({ apparentDiscountPct, grossYieldPct: 5, ceilingSnapshot: ceiling });

    // Avant : une décote de 37 % (occupé) ou 94 % (aberrante) ajoutait 24 points.
    expect(score(occupied.apparentDiscountPct)).toBe(score(null));
    expect(score(absurd.apparentDiscountPct)).toBe(score(null));
    expect(score(reportOpportunity(100_000, "vacant").apparentDiscountPct)).toBe(
      (score(null) ?? 0) + 24,
    );
  });
});
