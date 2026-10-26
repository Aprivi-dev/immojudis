import { describe, expect, it } from "vitest";
import {
  classifyOccupancy,
  computeAcquisitionCosts,
  DEFAULT_PRELIMINARY_FEES,
  computeEmolumentsHT,
  computeMarketCeiling,
  computeRecommendedCeilings,
  computeRentabilityScore,
  estimateWorksBudget,
  MARKET_CEILING_SCENARIOS,
  registrationRateForDepartment,
  WORKS_SCENARIOS,
} from "./profitability";

describe("estimateWorksBudget", () => {
  it("names the market statistic actually used when the prudent P10 is missing", () => {
    const input = {
      surface: 57.6,
      price: 110000,
      works: 28800,
      scenario: "prudent" as const,
      medianPricePerM2: 3022,
    };
    const fallback = computeMarketCeiling(input);
    expect(fallback.basis).toBe("median");
    expect(fallback.basisLabel).toBe("médiane locale");
    const p10 = computeMarketCeiling({ ...input, p10PricePerM2: 2400 });
    expect(p10.basis).toBe("p10");
    expect(p10.marketReferencePricePerM2).toBe(2400);
    expect(p10.maxBid).toBeLessThan(fallback.maxBid);
  });
  it("exposes the three reference prices per square metre", () => {
    expect(WORKS_SCENARIOS.map((scenario) => scenario.pricePerM2)).toEqual([500, 1_440, 1_850]);
  });

  it("reproduces the reference budgets from the renovation examples", () => {
    expect(estimateWorksBudget(25, "rafraichissement")).toBe(12_500);
    expect(estimateWorksBudget(65, "confort")).toBe(93_600);
    expect(estimateWorksBudget(120, "premium")).toBe(222_000);
  });

  it("never returns a negative works budget", () => {
    expect(estimateWorksBudget(-25, "premium")).toBe(0);
    expect(estimateWorksBudget(null, "confort")).toBe(0);
  });
});

describe("computeEmolumentsHT", () => {
  // Cas de référence calculés tranche par tranche avec le barème de l'article
  // A444-191 (7,256 % / 2,993 % / 1,995 % / 1,497 %). Le premier reprend
  // l'exemple publié par un cabinet d'avocats (2 242,56 € HT pour 100 000 €).
  it.each([
    [50_000, 1_444.26],
    [100_000, 2_242.56],
    [250_000, 4_488.06],
  ])("reproduit le décompte de %d €", (price, expected) => {
    expect(computeEmolumentsHT(price)).toBeCloseTo(expected, 1);
  });
});

describe("registrationRateForDepartment", () => {
  it("applique le taux plein par défaut et le taux de l'Indre", () => {
    expect(registrationRateForDepartment("33")).toBeCloseTo(0.0632, 4);
    expect(registrationRateForDepartment(null)).toBeCloseTo(0.0632, 4);
    expect(registrationRateForDepartment("36")).toBeCloseTo(0.0509, 4);
  });
});

describe("computeAcquisitionCosts", () => {
  it("applique émoluments, droits sur le prix seul, CSI et honoraires, frais préalables en plus", () => {
    const result = computeAcquisitionCosts({ price: 100_000 });

    expect(result.emolumentsHT).toBeCloseTo(2_242.56, 1);
    expect(result.emolumentsTTC).toBeCloseTo(2_691.07, 1);
    // Base taxable = le prix seul : les frais préalables (frais de poursuite taxés, 5 000 € par
    // défaut) en sont exclus (BOFiP BOI-ENR-DMTOI-10-10-30-20 (Adjudication), § 50).
    expect(result.registrationDuties).toBeCloseTo(100_000 * 0.0632, 2);
    expect(result.csi).toBeCloseTo(100, 2);
    expect(result.lawyerFees).toBe(1_500);
    expect(result.fpt).toBe(5_000);
    expect(result.fpt).toBe(DEFAULT_PRELIMINARY_FEES);
    // Les frais préalables restent dus en plus du prix, sans droits.
    expect(result.acquisitionFeesTotal).toBeCloseTo(15_611.07, 1);
    expect(result.totalCost).toBeCloseTo(115_611.07, 1);
    expect(result.organizationFees).toBe(0);
    expect(result.negotiationFees).toBe(0);
    expect(result.advertisingFees).toBe(0);
  });

  it("ne change pas les droits quand les frais préalables changent (hors base)", () => {
    const base = computeAcquisitionCosts({ price: 100_000, fpt: 0 });
    const withFees = computeAcquisitionCosts({ price: 100_000, fpt: 8_000 });
    expect(withFees.registrationDuties).toBe(base.registrationDuties);
    expect(withFees.csi).toBe(base.csi);
    expect(withFees.acquisitionFeesTotal - base.acquisitionFeesTotal).toBeCloseTo(8_000, 6);
  });

  it("utilise le taux de l'utilisateur quand il est saisi", () => {
    const result = computeAcquisitionCosts({
      price: 100_000,
      department: "36",
      registrationRate: 0.0581,
    });
    expect(result.registrationDuties).toBeCloseTo(100_000 * 0.0581, 2);
    expect(computeAcquisitionCosts({ price: 100_000, department: "36" }).registrationRate).toBe(
      0.0509,
    );
  });

  it("remplace les droits par la TVA pour un bien soumis à TVA", () => {
    const result = computeAcquisitionCosts({ price: 100_000, taxRegime: "vat" });
    expect(result.registrationDuties).toBe(0);
    expect(result.csi).toBe(0);
    expect(result.vatOnPrice).toBe(20_000);
    expect(result.totalCost).toBeCloseTo(
      100_000 + 20_000 + result.emolumentsTTC + 1_500 + 5_000,
      2,
    );
  });

  it("clamps negative inputs to zero", () => {
    const result = computeAcquisitionCosts({
      price: -10_000,
      works: -5_000,
      fpt: -1_000,
      lawyerFees: -200,
    });

    expect(result.price).toBe(0);
    expect(result.works).toBe(0);
    expect(result.fpt).toBe(0);
    expect(result.lawyerFees).toBe(0);
    expect(result.totalCost).toBe(0);
  });
});

describe("occupation du bien", () => {
  const base = {
    surface: 50,
    price: 90_000,
    scenario: "offensif" as const,
    medianPricePerM2: 3_000,
  };

  it("donne deux plafonds différents pour un bien libre et un bien occupé", () => {
    const free = computeMarketCeiling({ ...base, occupancy: "free" });
    const occupied = computeMarketCeiling({ ...base, occupancy: "occupied" });
    expect(occupied.maxBid).toBeLessThan(free.maxBid);
    expect(occupied.occupancy?.applied).toBe(true);
    expect(occupied.occupancy?.discountAmount).toBe(Math.round(3_000 * 50 * 0.15));
    expect(occupied.occupancy?.bidReduction).toBe(free.maxBid - occupied.maxBid);
    expect(free.occupancy?.applied).toBe(false);
  });

  it("traite une occupation inconnue comme un bien occupé", () => {
    const unknown = computeMarketCeiling({ ...base, occupancy: "unknown" });
    expect(unknown.occupancy?.applied).toBe(true);
    expect(unknown.maxBid).toBe(computeMarketCeiling({ ...base, occupancy: "occupied" }).maxBid);
  });

  it("ajoute le portage : mois avant libération × charges mensuelles", () => {
    const withoutCarry = computeMarketCeiling({ ...base, occupancy: "occupied" });
    const withCarry = computeMarketCeiling({
      ...base,
      occupancy: "occupied",
      carryMonths: 12,
      monthlyCarryCharges: 300,
    });
    expect(withCarry.occupancy?.carryingCost).toBe(3_600);
    expect(withCarry.maxBid).toBeLessThan(withoutCarry.maxBid);
  });

  it("classe les statuts bruts", () => {
    expect(classifyOccupancy("Libre")).toBe("free");
    expect(classifyOccupancy("occupied")).toBe("occupied");
    expect(classifyOccupancy("Loué")).toBe("occupied");
    expect(classifyOccupancy(null)).toBe("unknown");
    expect(classifyOccupancy("unknown")).toBe("unknown");
  });
});

describe("scénario prudent", () => {
  it("avertit quand la borne basse manque et que la médiane est utilisée", () => {
    const result = computeMarketCeiling({
      surface: 50,
      price: 90_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
    });
    expect(result.warning).toMatch(/Borne basse indisponible/);
    const withLowBound = computeMarketCeiling({
      surface: 50,
      price: 90_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
      p10PricePerM2: 2_400,
    });
    expect(withLowBound.warning).toBeUndefined();
  });
});

describe("computeMarketCeiling", () => {
  it("exposes only the Prudent 8% and Offensif 4% profiles", () => {
    expect(
      MARKET_CEILING_SCENARIOS.map((scenario) => [scenario.key, scenario.safetyDiscountPct]),
    ).toEqual([
      ["prudent", 8],
      ["offensif", 4],
    ]);
  });

  it("returns unavailable when surface is missing", () => {
    const result = computeMarketCeiling({
      surface: null,
      price: 100_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("Surface manquante");
  });

  it("uses manual market price as the reference when provided", () => {
    const result = computeMarketCeiling({
      surface: 50,
      price: 90_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
      manualMarketPricePerM2: 2_800,
    });

    expect(result.available).toBe(true);
    expect(result.basis).toBe("manual");
    expect(result.safetyDiscountPct).toBe(8);
    expect(result.marketReferencePricePerM2).toBe(2_800);
  });

  it("deducts a selected works scenario from the auction ceiling", () => {
    const ceilings = computeRecommendedCeilings({
      surface: 50,
      price: 90_000,
      scenario: "prudent",
      medianPricePerM2: 3_000,
      p25PricePerM2: 2_700,
    });

    expect(ceilings.refreshWorksBudget).toBe(25_000);
    expect(ceilings.withoutWorks.simulated.works).toBe(0);
    expect(ceilings.withRefreshWorks.simulated.works).toBe(25_000);
    expect(ceilings.withRefreshWorks.maxBid).toBeLessThan(ceilings.withoutWorks.maxBid);
    expect(ceilings.withRefreshWorks.maxBid).toBeLessThanOrEqual(
      ceilings.withoutWorks.maxBid - 23_000,
    );
  });
});

describe("computeRentabilityScore", () => {
  it("scores a rental project with explicit rent and financing assumptions", () => {
    const result = computeRentabilityScore({
      surface: 50,
      price: 100_000,
      works: 10_000,
      fpt: 3_000,
      department: "33",
      monthlyRent: 900,
      downPaymentPct: 30,
      annualInterestRatePct: 3.8,
      loanDurationYears: 20,
      marketMarginPerM2: 260,
    });

    expect(result.available).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.label).toBe("Très rentable à confirmer");
    expect(result.rentSource).toBe("manual");
    expect(result.grossYieldPct).toBeGreaterThan(result.netYieldPct ?? 0);
    expect(result.cashflowMonthly).not.toBeNull();
    expect(result.factors.map((factor) => factor.key)).toEqual(
      expect.arrayContaining(["gross_yield", "net_yield", "cashflow", "market_margin"]),
    );
  });

  it("uses a department rent estimate when monthly rent is missing", () => {
    const result = computeRentabilityScore({
      surface: 40,
      price: 120_000,
      department: "75",
    });

    expect(result.available).toBe(true);
    expect(result.rentSource).toBe("department_estimate");
    expect(result.monthlyRent).toBe(1_280);
    expect(result.factors.some((factor) => factor.key === "rent_source" && factor.delta < 0)).toBe(
      true,
    );
  });

  it("uses the ANIL rent of the commune, and flags only an indicative reliability", () => {
    const reference = (reliability: "reliable" | "indicative") => ({
      rentPerM2: 20,
      source: "anil_commune" as const,
      reliability,
      segment: "apt_all" as const,
      communeCode: "75108",
      lowPerM2: 17,
      highPerM2: 23,
      observations: 900,
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    const base = { surface: 40, price: 120_000, department: "75" };

    const reliable = computeRentabilityScore({ ...base, rentReference: reference("reliable") });
    expect(reliable.rentSource).toBe("anil_commune");
    expect(reliable.monthlyRent).toBe(800);
    expect(reliable.rentReliability).toBe("reliable");
    expect(reliable.rentVintage).toBe(2025);
    expect(reliable.rentSourceUpdatedOn).toBe("2025-12-11");
    expect(reliable.factors.some((factor) => factor.key === "rent_source")).toBe(false);

    const indicative = computeRentabilityScore({ ...base, rentReference: reference("indicative") });
    expect(indicative.rentReliability).toBe("indicative");
    expect(
      indicative.factors.some((factor) => factor.key === "rent_source" && factor.delta < 0),
    ).toBe(true);

    // A typed rent still wins, and carries no ANIL source.
    const manual = computeRentabilityScore({
      ...base,
      monthlyRent: 900,
      rentReference: reference("reliable"),
    });
    expect(manual.rentSource).toBe("manual");
    expect(manual.rentReliability).toBeNull();
  });

  it("returns unavailable when the surface is missing", () => {
    const result = computeRentabilityScore({
      surface: null,
      price: 120_000,
      department: "75",
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe("Surface manquante");
    expect(result.score).toBeNull();
  });
});
