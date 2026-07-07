import { describe, expect, it } from "vitest";
import {
  computeAcquisitionCosts,
  computeMarketCeiling,
  computeRentabilityScore,
} from "./profitability";

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
