import { afterEach, describe, expect, it, vi } from "vitest";
import { computeAcquisitionCosts } from "./profitability";
import { estimateGrossYieldPct, estimateSaleGrossYieldPct, geocodeAdministrativeArea } from "./geo";
import { defaultRentPerM2, rentReferenceFromAnilRow } from "./rent-reference";
vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));
afterEach(() => vi.unstubAllGlobals());
it("geocodes administrative areas without confusing them with streets", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      features: [{ geometry: { coordinates: [-0.6, 44.8] }, properties: { name: "Gironde" } }],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await geocodeAdministrativeArea("Gironde")).toMatchObject({ lat: 44.8, lng: -0.6 });
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.searchParams.get("types")).toBe("region,district");
  expect(url.searchParams.get("q")).toBe("Gironde");
});

describe("estimateSaleGrossYieldPct", () => {
  const sale = { starting_price_eur: 100_000, department: "33", property_type: "apartment" };

  it("donne le rendement d'un logement, avec la référence de la vente ou le repère départemental", () => {
    expect(estimateSaleGrossYieldPct(sale, 50)).toBe(estimateGrossYieldPct(100_000, 50, "33"));
    expect(estimateSaleGrossYieldPct({ ...sale, property_type: null }, 50)).not.toBeNull();
  });

  it("codes anglais du pipeline : seuls house et apartment ont un rendement, unknown seulement avec une surface", () => {
    for (const property_type of ["house", "apartment"]) {
      expect(
        estimateSaleGrossYieldPct({ ...sale, property_type }, 50),
        property_type,
      ).not.toBeNull();
    }
    for (const property_type of ["mixed", "other", "land", "building", "commercial"]) {
      expect(estimateSaleGrossYieldPct({ ...sale, property_type }, 50), property_type).toBeNull();
    }
    for (const property_type of ["unknown", "", null]) {
      expect(estimateSaleGrossYieldPct({ ...sale, property_type }, 50)).not.toBeNull();
      expect(estimateSaleGrossYieldPct({ ...sale, property_type }, null)).toBeNull();
    }
  });

  it("ne donne aucun rendement à un bien qui n'est pas un logement", () => {
    for (const property_type of [
      "land",
      "parking",
      "garage",
      "local commercial",
      "bureau",
      "building",
    ]) {
      expect(estimateSaleGrossYieldPct({ ...sale, property_type }, 50), property_type).toBeNull();
      expect(
        estimateSaleGrossYieldPct({ ...sale, property_type }, 50, {
          rentPerM2: 20,
          source: "anil_commune",
          reliability: "reliable",
        }),
      ).toBeNull();
    }
  });
});

describe("estimateGrossYieldPct", () => {
  it("rapporte le loyer de référence au coût total d'acquisition, pas au prix + 10 %", () => {
    const total = computeAcquisitionCosts({ price: 100_000, department: "33" }).totalCost;
    const expected = ((50 * (defaultRentPerM2("33") as number) * 12) / total) * 100;
    expect(estimateGrossYieldPct(100_000, 50, "33")).toBeCloseTo(expected, 6);
    expect(estimateGrossYieldPct(100_000, 50, "Gironde")).toBeCloseTo(expected, 6);
  });

  it("n'invente aucun loyer pour un département sans référence", () => {
    expect(defaultRentPerM2("23")).toBeNull();
    expect(defaultRentPerM2("19")).toBeNull();
    expect(estimateGrossYieldPct(100_000, 50, "23")).toBeNull();
    expect(estimateGrossYieldPct(100_000, 50, null)).toBeNull();
  });

  it("utilise le loyer ANIL de la commune quand la vente en a un, même sans repère départemental", () => {
    const anil = rentReferenceFromAnilRow({
      commune_code: "23096",
      segment: "apt_all",
      rent_per_m2: 7.5,
      rent_low_per_m2: 6,
      rent_high_per_m2: 9,
      prediction_type: "maille",
      observations_commune: 3,
      r2_adj: 0.6,
      vintage: 2025,
      source_updated_on: "2025-12-11",
    });
    const total = computeAcquisitionCosts({ price: 100_000, department: "23" }).totalCost;

    expect(estimateGrossYieldPct(100_000, 50, "23", anil)).toBeCloseTo(
      ((50 * 7.5 * 12) / total) * 100,
      6,
    );
    // Sans référence ANIL, le repli départemental reste celui d'avant.
    expect(estimateGrossYieldPct(100_000, 50, "23", null)).toBeNull();
    expect(estimateGrossYieldPct(100_000, 50, "33", null)).toBe(
      estimateGrossYieldPct(100_000, 50, "33"),
    );
  });
});
