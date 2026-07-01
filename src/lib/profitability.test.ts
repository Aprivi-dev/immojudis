import { describe, expect, it } from "vitest";
import { computeAcquisitionCosts, computeMarketCeiling } from "./profitability";

describe("computeAcquisitionCosts", () => {
  it("applies judicial auction fees and registration duties", () => {
    const result = computeAcquisitionCosts({ price: 100_000 });

    expect(result.emolumentsHT).toBeCloseTo(2_266.75, 2);
    expect(result.emolumentsTTC).toBeCloseTo(2_720.1, 2);
    expect(result.registrationDuties).toBe(5_800);
    expect(result.fpt).toBe(3_000);
    expect(result.acquisitionFeesTotal).toBeCloseTo(11_520.1, 2);
    expect(result.totalCost).toBeCloseTo(111_520.1, 2);
  });

  it("clamps negative inputs to zero", () => {
    const result = computeAcquisitionCosts({ price: -10_000, works: -5_000, fpt: -1_000 });

    expect(result.price).toBe(0);
    expect(result.works).toBe(0);
    expect(result.fpt).toBe(0);
    expect(result.totalCost).toBe(0);
  });
});

describe("computeMarketCeiling", () => {
  it("returns unavailable when surface is missing", () => {
    const result = computeMarketCeiling({
      surface: null,
      price: 100_000,
      scenario: "equilibre",
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
    expect(result.safetyDiscountPct).toBe(16);
    expect(result.marketReferencePricePerM2).toBe(2_800);
  });
});
