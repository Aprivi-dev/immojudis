import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketEngineCandidate } from "@/lib/market-estimation-engine";
import type { RadiusAnalysis } from "@/lib/market-server/types";

const analyzeAtRadius = vi.hoisted(() => vi.fn());
vi.mock("@/lib/market-server/radius-analysis", () => ({ analyzeAtRadius }));
const analyzeMarketCandidates = vi.hoisted(() => vi.fn());
vi.mock("@/lib/market-estimation-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/market-estimation-engine")>();
  analyzeMarketCandidates.mockImplementation(actual.analyzeMarketCandidates);
  return { ...actual, analyzeMarketCandidates };
});

import { getMarketEstimate } from "@/lib/market.server";

function candidate(index: number, distanceM: number, pricePerM2 = 3_600): MarketEngineCandidate {
  return {
    id: `mutation-${index}`,
    parcelId: `parcel-${index}`,
    date: "2025-10-10",
    totalPrice: 70 * pricePerM2,
    builtSurfaceM2: 70,
    landSurfaceM2: null,
    pricePerM2,
    propertyType: "UN APPARTEMENT",
    segment: "apartment",
    distanceM,
    latitude: 44.8378,
    longitude: -0.5792,
  };
}

/** Rend les ventes dont la distance tient dans le rayon demandé. */
function serve(sales: MarketEngineCandidate[]) {
  analyzeAtRadius.mockImplementation(
    async (_lat: number, _lng: number, radiusM: number): Promise<RadiusAnalysis> => ({
      source: "cerema_dvf",
      candidates: sales.filter((sale) => sale.distanceM <= radiusM),
      addressMutations: [],
      totalNearby: sales.length,
      collectionComplete: true,
      missingYears: [],
    }),
  );
}

function estimate() {
  return getMarketEstimate({
    lat: 44.8378,
    lng: -0.5792,
    propertyType: "apartment",
    surfaceKind: "carrez",
    surfaceScope: "total",
    surfaceM2: 70,
    landSurfaceM2: null,
  });
}

beforeEach(() => {
  analyzeAtRadius.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([{ code: "33063", nom: "Ville test", population: 100_000 }])),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const near = (count: number, start = 0) =>
  Array.from({ length: count }, (_, k) => candidate(start + k, 100, 3_600 + (start + k) * 20));

describe("élargissement du rayon aligné sur la porte publique", () => {
  it("élargit au-delà de 4 comparables pour atteindre l'effectif exigé par la porte", async () => {
    // Appartement urbain : rayons 150, 300, 600, 1 000, 2 000. 4 ventes à 100 m, 3 de plus à 250 m.
    serve([...near(4), ...[4, 5, 6].map((index) => candidate(index, 250, 3_600 + index * 20))]);
    const response = await estimate();
    expect(response.estimate).toMatchObject({ radiusM: 300, actionable: true });
    expect(response.estimate?.sampleSize).toBeGreaterThanOrEqual(6);
    expect(response.estimate?.predictionInterval?.method).toBe("local_jackknife");
  });

  it("garde le premier rayon quand l'élargissement n'ajoute aucun comparable", async () => {
    serve(near(4));
    const response = await estimate();
    expect(response.estimate).toMatchObject({ radiusM: 150, sampleSize: 4, actionable: true });
    // Les rayons admis par la porte (jusqu'à 1 000 m) ont été essayés, pas le suivant.
    const radii = analyzeAtRadius.mock.calls.map((call) => call[2]);
    expect(radii).toEqual([150, 300, 600, 1_000]);
  });

  it("ne dépasse pas le rayon admis par la porte pour atteindre l'effectif", async () => {
    // Les ventes supplémentaires sont à 1 500 m : hors porte pour un appartement urbain.
    serve([...near(4), ...[4, 5, 6].map((index) => candidate(index, 1_500, 3_600 + index * 20))]);
    const response = await estimate();
    expect(response.estimate).toMatchObject({ radiusM: 150, sampleSize: 4 });
  });

  it("n'élargit plus une estimation qui a déjà l'effectif exigé", async () => {
    serve(near(6));
    await estimate();
    expect(analyzeAtRadius).toHaveBeenCalledTimes(1);
  });

  it("garde l'estimation exploitable quand un rayon plus large la rendrait trop dispersée", async () => {
    serve([...near(4), ...[4, 5, 6].map((index) => candidate(index, 250, 3_600 + index * 20))]);
    const real = analyzeMarketCandidates.getMockImplementation()!;
    // À 300 m, le moteur trouve 6 ventes mais une dispersion qui ôte le caractère exploitable.
    analyzeMarketCandidates.mockImplementation((input) => {
      const result = real(input);
      return result && input.candidates.length > 4 ? { ...result, actionable: false } : result;
    });
    try {
      const response = await estimate();
      expect(response.estimate).toMatchObject({ radiusM: 150, sampleSize: 4, actionable: true });
    } finally {
      analyzeMarketCandidates.mockImplementation(real);
    }
  });
});
