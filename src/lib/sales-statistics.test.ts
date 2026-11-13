import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  getSales: vi.fn(),
  loadRents: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("@/lib/entitlements.server", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/queries", () => ({ getSales: mocks.getSales }));
vi.mock("@/lib/rent-reference.server", () => ({
  createRentLookupSession: () => ({ load: mocks.loadRents }),
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: mocks.usage }));
vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));

import { buildSalesStatisticsSummary, getSalesStatistics } from "@/lib/sales-statistics";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";

function makeSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: overrides.id ?? crypto.randomUUID(),
    title: "Vente statistique",
    starting_price_eur: 100_000,
    app_surface_m2: 50,
    investment_score: 70,
    sale_date: "2026-07-20T09:00:00.000Z",
    status: "active",
    source_blocks: { dpe_classe: "C" },
    ...overrides,
  };
}

const auth = { userId: "user-1", supabase: {} } as never;

/** Les repères que le panneau « Repères sur votre recherche » affiche, et rien d'autre. */
const DISPLAYED_KEYS = [
  "averageInvestmentScore",
  "capped",
  "dpeCounts",
  "dpeKnownCount",
  "medianPriceEur",
  "medianPricePerM2",
  "sampleSize",
];

describe("statistiques de la recherche (route /api/sales/statistics)", () => {
  const sales = [
    makeSale({ id: "a", department: "23", starting_price_eur: 100_000, app_surface_m2: 50 }),
    makeSale({ id: "b", department: "23", starting_price_eur: 100_000, app_surface_m2: 50 }),
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.plan.mockResolvedValue({ plan: "analyse" });
    mocks.getSales.mockResolvedValue(sales);
    mocks.loadRents.mockResolvedValue(() => null);
  });

  it("ne rend que les repères affichés, sans lire de loyer ni calculer de rendement", async () => {
    const response = await getSalesStatistics({ auth, search: {} });

    expect(Object.keys(response)).toEqual(["summary"]);
    expect(Object.keys(response.summary).sort()).toEqual(DISPLAYED_KEYS);
    expect(mocks.loadRents).not.toHaveBeenCalled();
  });

  it("ne lit les loyers de la carte ANIL que pour le filtre « rendement minimal »", async () => {
    await getSalesStatistics({ auth, search: { minYield: 5 } });

    expect(mocks.loadRents).toHaveBeenCalledTimes(1);
    expect(mocks.loadRents).toHaveBeenCalledWith(sales);
  });

  it("mesure l'usage avec la taille de l'échantillon et les filtres de l'URL", async () => {
    await getSalesStatistics({ auth, search: { department: "23" } });

    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "sales.statistics_viewed",
        metadata: { sample_size: 2, capped: false, filters: { department: "23" } },
      }),
    );
  });

  it("reste réservée à l'offre Analyse", async () => {
    mocks.plan.mockResolvedValue({ plan: "decouverte" });

    await expect(getSalesStatistics({ auth, search: {} })).rejects.toMatchObject({ status: 403 });
    expect(mocks.getSales).not.toHaveBeenCalled();
  });
});

describe("sales statistics", () => {
  it("builds aggregate search statistics from judicial sales", () => {
    const summary = buildSalesStatisticsSummary([
      makeSale({
        id: "sale-1",
        department: "33",
        property_type: "house",
        starting_price_eur: 100_000,
        app_surface_m2: 50,
        investment_score: 70,
        source_blocks: { dpe_classe: "C" },
      }),
      makeSale({
        id: "sale-2",
        department: "33",
        property_type: "apartment",
        starting_price_eur: 200_000,
        app_surface_m2: 100,
        investment_score: 80,
        sale_date: "2026-06-01T09:00:00.000Z",
        source_blocks: { dpe_classe: "D" },
        adjudication_price_eur: 230_000,
        status: "adjudicated",
      }),
      makeSale({
        id: "sale-3",
        department: "75",
        property_type: "apartment",
        starting_price_eur: 300_000,
        app_surface_m2: null,
        investment_score: null,
        source_blocks: null,
      }),
    ]);

    expect(summary).toMatchObject({
      sampleSize: 3,
      capped: false,
      medianPriceEur: 200_000,
      medianPricePerM2: 2_000,
      averageInvestmentScore: 75,
      dpeKnownCount: 2,
    });
    expect(summary.dpeCounts).toMatchObject({
      C: 1,
      D: 1,
    });
  });

  it("dit si l'échantillon a atteint le plafond de lecture", () => {
    expect(buildSalesStatisticsSummary([makeSale()], true).capped).toBe(true);
    expect(buildSalesStatisticsSummary([]).sampleSize).toBe(0);
  });
});
