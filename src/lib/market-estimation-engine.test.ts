import { describe, expect, it } from "vitest";
import {
  analyzeMarketCandidates,
  mutationSegmentFromCode,
  resolveMarketPropertySegment,
  type MarketEngineCandidate,
} from "@/lib/market-estimation-engine";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function comparable(
  id: string,
  overrides: Partial<MarketEngineCandidate> = {},
): MarketEngineCandidate {
  return {
    id,
    parcelId: `parcel-${id}`,
    date: "2026-02-10",
    totalPrice: 300_000,
    builtSurfaceM2: 75,
    landSurfaceM2: null,
    pricePerM2: 4_000,
    propertyType: "Appartement",
    segment: "apartment",
    distanceM: 180,
    ...overrides,
  };
}

describe("market estimation engine", () => {
  it("treats a land application surface as land rather than built area", () => {
    expect(
      resolveMarketPropertySegment({
        propertyType: "land",
        surfaceKind: "land",
        surfaceScope: "land",
      }),
    ).toBe("land");
  });

  it("recognizes buildings and commercial premises as distinct segments", () => {
    expect(resolveMarketPropertySegment({ propertyType: "building" })).toBe("building");
    expect(resolveMarketPropertySegment({ propertyType: "commercial" })).toBe("commercial");
    expect(mutationSegmentFromCode("123")).toBe("building");
    expect(mutationSegmentFromCode("143")).toBe("commercial");
  });

  it("never mixes apartments and houses to reach the sample threshold", () => {
    const result = analyzeMarketCandidates({
      segment: "house",
      subjectBuiltSurfaceM2: 100,
      subjectLandSurfaceM2: 500,
      now: NOW,
      candidates: [
        comparable("house-1", {
          segment: "house",
          propertyType: "Maison",
          builtSurfaceM2: 105,
          landSurfaceM2: 520,
          pricePerM2: 2_800,
        }),
        ...Array.from({ length: 8 }, (_, index) =>
          comparable(`apartment-${index}`, { pricePerM2: 8_000 + index * 100 }),
        ),
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.sampleSize).toBe(1);
    expect(result?.actionable).toBe(false);
    expect(result?.comparables.every((item) => item.segment === "house")).toBe(true);
  });

  it("estimates land from land prices and land surfaces only", () => {
    const result = analyzeMarketCandidates({
      segment: "land",
      subjectBuiltSurfaceM2: null,
      subjectLandSurfaceM2: 800,
      now: NOW,
      candidates: [
        comparable("land-1", {
          segment: "land",
          propertyType: "Terrain",
          builtSurfaceM2: null,
          landSurfaceM2: 760,
          totalPrice: 152_000,
          pricePerM2: 200,
        }),
        comparable("land-2", {
          segment: "land",
          propertyType: "Terrain",
          builtSurfaceM2: null,
          landSurfaceM2: 820,
          totalPrice: 172_200,
          pricePerM2: 210,
        }),
        comparable("land-3", {
          segment: "land",
          propertyType: "Terrain",
          builtSurfaceM2: null,
          landSurfaceM2: 900,
          totalPrice: 198_000,
          pricePerM2: 220,
        }),
        comparable("land-4", {
          segment: "land",
          propertyType: "Terrain",
          builtSurfaceM2: null,
          landSurfaceM2: 700,
          totalPrice: 136_500,
          pricePerM2: 195,
        }),
      ],
    });

    expect(result).toMatchObject({
      mode: "land_matched",
      sampleSize: 4,
      actionable: true,
    });
    expect(result?.medianPricePerM2).toBeGreaterThanOrEqual(195);
    expect(result?.medianPricePerM2).toBeLessThanOrEqual(220);
    expect(result?.comparables.every((item) => item.primarySurfaceM2 >= 700)).toBe(true);
  });

  it("uses both built and land similarity for houses when enough evidence exists", () => {
    const result = analyzeMarketCandidates({
      segment: "house",
      subjectBuiltSurfaceM2: 110,
      subjectLandSurfaceM2: 600,
      now: NOW,
      candidates: [
        comparable("h1", {
          segment: "house",
          propertyType: "Maison",
          builtSurfaceM2: 108,
          landSurfaceM2: 590,
          pricePerM2: 3_000,
        }),
        comparable("h2", {
          segment: "house",
          propertyType: "Maison",
          builtSurfaceM2: 115,
          landSurfaceM2: 650,
          pricePerM2: 3_100,
        }),
        comparable("h3", {
          segment: "house",
          propertyType: "Maison",
          builtSurfaceM2: 100,
          landSurfaceM2: 500,
          pricePerM2: 2_900,
        }),
        comparable("h4", {
          segment: "house",
          propertyType: "Maison",
          builtSurfaceM2: 120,
          landSurfaceM2: 720,
          pricePerM2: 3_200,
        }),
      ],
    });

    expect(result?.mode).toBe("surface_land_matched");
    expect(result?.actionable).toBe(true);
    expect(result?.comparables[0].scoreBreakdown.land).not.toBeNull();
  });

  it("normalizes older sales over time and returns a calibrated P10-P90 interval", () => {
    const prices = [3_000, 3_150, 3_300, 3_450, 3_600, 3_750, 3_900, 4_050];
    const result = analyzeMarketCandidates({
      segment: "apartment",
      subjectBuiltSurfaceM2: 75,
      subjectLandSurfaceM2: null,
      subjectLatitude: 44.8378,
      subjectLongitude: -0.5792,
      now: NOW,
      candidates: prices.map((pricePerM2, index) =>
        comparable(`trend-${index}`, {
          date: `${2023 + Math.floor(index / 2)}-${index % 2 === 0 ? "02" : "08"}-10`,
          pricePerM2,
          latitude: 44.8378 + index * 0.0001,
          longitude: -0.5792 + index * 0.0001,
        }),
      ),
    });

    expect(result?.annualMarketTrendPct).toBeGreaterThan(0);
    expect(result?.marketCell).toMatch(/^[0-9a-f]+$/);
    expect(result?.predictionInterval.coverageTarget).toBe(0.8);
    expect(result?.p10PricePerM2).toBeLessThan(result?.medianPricePerM2 ?? 0);
    expect(result?.p90PricePerM2).toBeGreaterThan(result?.medianPricePerM2 ?? 0);
    expect(result?.comparables[0].scoreBreakdown.microMarket).not.toBeNull();
    expect(
      result?.comparables.some(
        (item) =>
          item.timeAdjustmentFactor > 1 && item.adjustedPricePerM2 > item.observedPricePerM2,
      ),
    ).toBe(true);
  });
});
