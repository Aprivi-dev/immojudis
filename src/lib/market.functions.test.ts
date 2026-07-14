import { afterEach, describe, expect, it, vi } from "vitest";
import { getMarketEstimate, officialDvfCommuneCode } from "@/lib/market.functions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("market estimate DVF collection", () => {
  it("maps municipal arrondissement postcodes to official DVF commune files", () => {
    expect(officialDvfCommuneCode("13055", "13013")).toBe("13213");
    expect(officialDvfCommuneCode("75056", "75008")).toBe("75108");
    expect(officialDvfCommuneCode("69123", "69003")).toBe("69383");
    expect(officialDvfCommuneCode("06029", "06400")).toBe("06029");
  });

  it("follows Cerema pagination and returns an actionable same-segment estimate", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("geo.api.gouv.fr")) {
          return Response.json([{ nom: "Ville test", population: 100_000 }]);
        }
        const parsed = new URL(url);
        const year = Number(parsed.searchParams.get("anneemut"));
        const page = Number(parsed.searchParams.get("page") ?? "1");
        if (year !== 2025) {
          return Response.json({ count: 0, next: null, features: [] });
        }
        const start = page === 1 ? 0 : 500;
        const end = page === 1 ? 500 : 501;
        const features = Array.from({ length: end - start }, (_, index) => feature(start + index));
        return Response.json({
          count: 501,
          next: page === 1 ? "http://example.test/page=2" : null,
          features,
        });
      }),
    );

    const response = await getMarketEstimate({
      lat: 44.8378,
      lng: -0.5792,
      propertyType: "apartment",
      surfaceKind: "carrez",
      surfaceScope: "total",
      surfaceM2: 75,
      landSurfaceM2: null,
    });

    expect(urls.some((url) => url.includes("anneemut=2025") && url.includes("page=2"))).toBe(true);
    expect(response.ok).toBe(true);
    expect(response.estimate).toMatchObject({
      engineVersion: "v3",
      engineKind: "comparable_ensemble",
      segment: "apartment",
      surfaceBasis: "built",
      actionable: true,
      collectionComplete: true,
    });
    expect(response.estimate?.recentTransactions.length).toBeGreaterThan(0);
    expect(
      response.estimate?.recentTransactions.every((item) => item.type === "UN APPARTEMENT"),
    ).toBe(true);
  });

  it("geocodes a published address when coordinates are missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("data.geopf.fr/geocodage")) {
          return Response.json({
            features: [
              {
                geometry: { coordinates: [-0.5792, 44.8378] },
                properties: { score: 0.93, _type: "address" },
              },
            ],
          });
        }
        if (url.includes("geo.api.gouv.fr")) {
          return Response.json([{ nom: "Bordeaux", population: 260_000 }]);
        }
        const year = Number(new URL(url).searchParams.get("anneemut"));
        return Response.json({
          count: year === 2025 ? 5 : 0,
          next: null,
          features: year === 2025 ? Array.from({ length: 5 }, (_, index) => feature(index)) : [],
        });
      }),
    );

    const response = await getMarketEstimate({
      address: "10 rue test",
      postalCode: "33000",
      city: "Bordeaux",
      propertyType: "apartment",
      surfaceM2: 75,
    });

    expect(response.estimate).toMatchObject({
      locationSource: "geocoded",
      locationApproximate: false,
      medianPricePerM2: expect.any(Number),
    });
  });

  it("keeps a room-based surface estimate indicative and exposes a total value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("geo.api.gouv.fr")) {
          return Response.json([{ nom: "Ville test", population: 100_000 }]);
        }
        const year = Number(new URL(url).searchParams.get("anneemut"));
        return Response.json({
          count: year === 2025 ? 5 : 0,
          next: null,
          features: year === 2025 ? Array.from({ length: 5 }, (_, index) => feature(index)) : [],
        });
      }),
    );

    const response = await getMarketEstimate({
      lat: 44.8378,
      lng: -0.5792,
      propertyType: "apartment",
      surfaceM2: 62,
      surfaceEstimated: true,
      surfaceAssumption: "surface provisoire de 62 m² estimée à partir de 3 pièces",
    });

    expect(response.estimate).toMatchObject({
      actionable: false,
      estimationLevel: "indicative",
      subjectSurfaceEstimated: true,
      estimatedValueEur: expect.any(Number),
      estimatedValueLowEur: expect.any(Number),
      estimatedValueHighEur: expect.any(Number),
    });
  });

  it("estimates a parking space from dependency-only DVF mutations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("geo.api.gouv.fr")) {
          return Response.json([
            {
              code: "06029",
              nom: "Cannes",
              codeDepartement: "06",
              population: 74_000,
            },
          ]);
        }
        if (url.includes("files.data.gouv.fr")) {
          return new Response(url.includes("/2025/") ? parkingCsv() : parkingCsv(false), {
            headers: { "content-type": "text/csv" },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const response = await getMarketEstimate({
      lat: 43.55537,
      lng: 7.03073,
      propertyType: "parking",
      surfaceM2: null,
    });

    expect(response.ok).toBe(true);
    expect(response.estimate).toMatchObject({
      segment: "parking",
      surfaceBasis: "unit",
      comparableMode: "unit_sales",
      estimatedValueEur: expect.any(Number),
      medianUnitPriceEur: expect.any(Number),
      actionable: false,
    });
    expect(response.estimate?.sampleSize).toBeGreaterThanOrEqual(8);
  });

  it("uses the official cadastral parcel area when a land listing has no surface", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("apicarto.ign.fr")) {
          return Response.json({
            features: [{ properties: { idu: "132138800D0532", contenance: 2035 } }],
          });
        }
        if (url.includes("geo.api.gouv.fr")) {
          return Response.json([
            {
              code: "13055",
              nom: "Marseille",
              codeDepartement: "13",
              population: 870_000,
            },
          ]);
        }
        if (url.includes("files.data.gouv.fr")) {
          return new Response(url.includes("/2025/") ? landCsv() : landCsv(false), {
            headers: { "content-type": "text/csv" },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );

    const response = await getMarketEstimate({
      lat: 43.33757,
      lng: 5.4513,
      postalCode: "13013",
      propertyType: "land",
      surfaceKind: "land",
      surfaceScope: "land",
      surfaceM2: null,
      landSurfaceM2: null,
    });

    expect(response.ok).toBe(true);
    expect(response.estimate).toMatchObject({
      segment: "land",
      surfaceBasis: "land",
      subjectSurfaceM2: 2035,
      subjectSurfaceEstimated: true,
      estimatedValueEur: expect.any(Number),
      actionable: false,
    });
    expect(response.estimate?.subjectSurfaceAssumption).toContain("cadastrale");
  });
});

function parkingCsv(withRows = true): string {
  const header = [
    "id_mutation",
    "date_mutation",
    "nature_mutation",
    "valeur_fonciere",
    "code_type_local",
    "type_local",
    "id_parcelle",
    "lot1_numero",
    "latitude",
    "longitude",
  ].join(",");
  if (!withRows) return `${header}\n`;
  const rows = Array.from({ length: 10 }, (_, index) =>
    [
      `2025-P-${index}`,
      "2025-04-02",
      "Vente",
      String(20_000 + index * 1_000),
      "3",
      "Dépendance",
      `06029000AB${String(index).padStart(4, "0")}`,
      String(100 + index),
      String(43.55537 + index * 0.0001),
      String(7.03073 + index * 0.0001),
    ].join(","),
  );
  return `${header}\n${rows.join("\n")}\n`;
}

function landCsv(withRows = true): string {
  const header = [
    "id_mutation",
    "date_mutation",
    "nature_mutation",
    "valeur_fonciere",
    "code_type_local",
    "surface_reelle_bati",
    "surface_terrain",
    "id_parcelle",
    "latitude",
    "longitude",
  ].join(",");
  if (!withRows) return `${header}\n`;
  const rows = Array.from({ length: 6 }, (_, index) => {
    const surface = 1_700 + index * 100;
    return [
      `2025-L-${index}`,
      "2025-03-15",
      "Vente",
      String(surface * (280 + index * 5)),
      "",
      "",
      String(surface),
      `132138800D${String(index).padStart(4, "0")}`,
      String(43.33757 + index * 0.0001),
      String(5.4513 + index * 0.0001),
    ].join(",");
  });
  return `${header}\n${rows.join("\n")}\n`;
}

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
