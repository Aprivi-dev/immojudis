import { describe, expect, it } from "vitest";
import {
  buildDvfComparableAnalysis,
  type DvfComparableCandidate,
} from "@/lib/dvf-comparable-engine";

const NOW = new Date("2026-07-06T12:00:00.000Z");

function candidate(
  id: string,
  overrides: Partial<DvfComparableCandidate> = {},
): DvfComparableCandidate {
  return {
    id,
    saleDate: "2026-02-15",
    totalPriceEur: 200_000,
    surfaceM2: 50,
    propertyType: "Appartement",
    distanceM: 180,
    address: `${id} rue test`,
    city: "Bordeaux",
    postalCode: "33000",
    ...overrides,
  };
}

describe("dvf comparable engine", () => {
  it("ranks strict comparables and computes a defensible value range", () => {
    const analysis = buildDvfComparableAnalysis({
      subject: {
        surfaceM2: 50,
        propertyType: "Appartement",
        startingPriceEur: 150_000,
      },
      candidates: [
        candidate("nearest_recent", { totalPriceEur: 205_000, distanceM: 90 }),
        candidate("same_block", { totalPriceEur: 198_000, distanceM: 140, saleDate: "2025-11-10" }),
        candidate("recent_small", { totalPriceEur: 184_000, surfaceM2: 46, distanceM: 220 }),
        candidate("recent_large", { totalPriceEur: 238_000, surfaceM2: 58, distanceM: 260 }),
        candidate("older", { totalPriceEur: 196_000, saleDate: "2024-10-05", distanceM: 260 }),
        candidate("farther", { totalPriceEur: 215_000, surfaceM2: 52, distanceM: 280 }),
        candidate("outlier", { totalPriceEur: 620_000, surfaceM2: 50, distanceM: 100 }),
      ],
      options: { now: NOW, maxAgeMonths: 36, maxRadiusM: 1_000, limit: 10 },
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "detailed",
      comparableMode: "surface_matched",
      radiusM: 300,
      sampleSize: 6,
      outliersRemoved: 1,
      confidenceLabel: "forte",
      surfaceWindow: { minM2: 35, maxM2: 65, tolerancePct: 30 },
    });
    expect(analysis.medianPricePerM2).toBeGreaterThanOrEqual(3_900);
    expect(analysis.medianPricePerM2).toBeLessThanOrEqual(4_100);
    expect(analysis.medianValueEur).toBeGreaterThan(190_000);
    expect(analysis.apparentDiscountPct).toBeGreaterThan(20);
    expect(analysis.comparables[0].id).toBe("nearest_recent");
    expect(analysis.comparables[0].reasons).toEqual(
      expect.arrayContaining(["très proche", "vente récente", "même type", "surface comparable"]),
    );
  });

  it("falls back to type-only comparables when the surface window is too sparse", () => {
    const analysis = buildDvfComparableAnalysis({
      subject: {
        surfaceM2: 120,
        propertyType: "Maison",
        startingPriceEur: 320_000,
      },
      candidates: [
        candidate("house_1", {
          propertyType: "Maison",
          totalPriceEur: 240_000,
          surfaceM2: 72,
          distanceM: 250,
        }),
        candidate("house_2", {
          propertyType: "Maison",
          totalPriceEur: 260_000,
          surfaceM2: 76,
          distanceM: 350,
        }),
        candidate("house_3", {
          propertyType: "Maison",
          totalPriceEur: 315_000,
          surfaceM2: 90,
          distanceM: 500,
        }),
        candidate("house_4", {
          propertyType: "Maison",
          totalPriceEur: 460_000,
          surfaceM2: 140,
          distanceM: 700,
        }),
      ],
      options: { now: NOW, maxRadiusM: 1_000 },
    });

    expect(analysis).toMatchObject({
      available: true,
      comparableMode: "nearby_type_only",
      radiusM: 1_000,
      sampleSize: 4,
    });
    expect(analysis.warnings).toContain("surfaces élargies faute de références strictes");
    expect(analysis.nextActions[0]).toContain("Relire manuellement");
  });

  it("keeps missing comparable states explicit", () => {
    const analysis = buildDvfComparableAnalysis({
      subject: {
        surfaceM2: 50,
        propertyType: "Appartement",
        startingPriceEur: 180_000,
      },
      candidates: [
        candidate("too_old", { saleDate: "2020-01-01" }),
        candidate("invalid_surface", { surfaceM2: 0 }),
        candidate("too_expensive", { totalPriceEur: 2_000_000, surfaceM2: 40 }),
      ],
      options: { now: NOW, maxAgeMonths: 36 },
    });

    expect(analysis).toMatchObject({
      available: false,
      status: "missing",
      sampleSize: 0,
      confidenceLabel: "indisponible",
      medianPricePerM2: null,
    });
    expect(analysis.summary).toContain("Aucun comparable DVF exploitable");
  });
});
