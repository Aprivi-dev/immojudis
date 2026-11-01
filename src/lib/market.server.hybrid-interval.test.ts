import { afterEach, describe, expect, it, vi } from "vitest";

const applyActiveHybridModel = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hybrid-market-valuation", () => ({ applyActiveHybridModel }));

import { getMarketEstimate } from "@/lib/market.server";

afterEach(() => {
  vi.unstubAllGlobals();
  applyActiveHybridModel.mockReset();
});

function feature(index: number) {
  const offset = index * 0.0000001;
  const lng = -0.5792 + offset;
  const lat = 44.8378 + offset;
  const surface = 65 + (index % 20);
  const pricePerM2 = 3_600 + (index % 12) * 40;
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lng - 0.00001, lat - 0.00001],
          [lng + 0.00001, lat - 0.00001],
          [lng + 0.00001, lat + 0.00001],
          [lng - 0.00001, lat + 0.00001],
          [lng - 0.00001, lat - 0.00001],
        ],
      ],
    },
    properties: {
      idmutinvar: `mutation-${index}`,
      datemut: "2025-10-10",
      anneemut: 2025,
      libnatmut: "Vente",
      valeurfonc: String(surface * pricePerM2),
      sbati: String(surface),
      sterr: "0",
      nblocmut: 1,
      nbpar: 1,
      l_idpar: [`parcel-${index}`],
      codtypbien: "121",
      libtypbien: "UN APPARTEMENT",
    },
  };
}

function stubDvf() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("geo.api.gouv.fr")) {
        return Response.json([{ nom: "Ville test", population: 100_000 }]);
      }
      const year = Number(new URL(url).searchParams.get("anneemut"));
      if (year !== 2025) return Response.json({ count: 0, next: null, features: [] });
      return Response.json({
        count: 60,
        next: null,
        features: Array.from({ length: 60 }, (_, index) => feature(index)),
      });
    }),
  );
}

const request = {
  lat: 44.8378,
  lng: -0.5792,
  propertyType: "apartment",
  surfaceKind: "carrez",
  surfaceScope: "total",
  surfaceM2: 75,
  landSurfaceM2: null,
} as const;

describe("fourchette de l'estimation hybride (n° 21)", () => {
  it("ne transmet pas de couverture cible : celle du mélange modèle + comparables n'est pas mesurée", async () => {
    stubDvf();
    applyActiveHybridModel.mockResolvedValue({
      modelVersionId: "model-1",
      modelVersion: "v1",
      p10PricePerM2: 3_500,
      p50PricePerM2: 4_000,
      p90PricePerM2: 4_600,
      modelWeight: 0.4,
      calibrationMethod: "mapie_cqr",
      rawModelPrediction: { p10PricePerM2: 3_400, p50PricePerM2: 4_100, p90PricePerM2: 4_700 },
    });
    const { estimate } = await getMarketEstimate(request);
    expect(estimate?.engineKind).toBe("hybrid_lightgbm");
    expect(estimate?.predictionInterval).toBeDefined();
    expect(estimate?.predictionInterval).not.toHaveProperty("coverageTarget");
    expect(estimate?.predictionInterval?.method).toBe("hybrid_mapie_cqr");
  });

  it("garde la couverture cible du moteur de comparables quand aucun modèle n'est appliqué", async () => {
    stubDvf();
    applyActiveHybridModel.mockResolvedValue(null);
    const { estimate } = await getMarketEstimate(request);
    expect(estimate?.engineKind).toBe("comparable_ensemble");
    expect(estimate?.predictionInterval?.coverageTarget).toBe(0.8);
  });
});
