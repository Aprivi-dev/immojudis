import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  usage: vi.fn(),
  saleQuery: vi.fn(),
}));

vi.mock("@/lib/entitlements.server", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: mocks.usage }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));

import { PublicApiError } from "@/lib/api-errors";
import { getDvfComparables, dvfComparablesQuerySchema } from "@/lib/dvf-comparables";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const SALE_ID = "6f0f8d0e-6b1e-4b5e-9a39-0d7a4c1a1b11";

/** Un lot d'appartements voisins aux prix variés : la médiane doit être celle des 30, pas des 3. */
function rpcRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    source_mutation_id: `mut-${index}`,
    sale_date: "2026-03-10",
    mutation_nature: "Vente",
    total_price_eur: 50 * (3_000 + index * 100),
    built_surface_m2: 50,
    land_surface_m2: 0,
    price_per_m2: 3_000 + index * 100,
    property_type: "Appartement",
    dvf_property_type_code: "121",
    parcel_id: `parcel-${index}`,
    latitude: 44.84,
    longitude: -0.58,
    // Les plus proches sont les moins chers : un échantillon tronqué aux plus proches fausserait la médiane.
    distance_m: 50 + index * 10,
  }));
}

function authContext(sale: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: SALE_ID,
                  title: "Appartement",
                  city: "Bordeaux",
                  department: "33",
                  postal_code: "33000",
                  address: "1 rue test",
                  property_type: "Appartement",
                  starting_price_eur: 100_000,
                  app_surface_m2: 50,
                  habitable_surface_m2: 50,
                  carrez_surface_m2: 50,
                  land_surface_m2: null,
                  rooms_count: 3,
                  latitude: 44.84,
                  longitude: -0.58,
                  ...sale,
                },
                error: null,
              }),
          }),
        }),
      }),
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.plan.mockResolvedValue({ plan: "analyse" });
  mocks.rpc.mockResolvedValue({ data: rpcRows(30), error: null });
  mocks.from.mockReturnValue({
    select: () => ({
      in: (_column: string, ids: string[]) =>
        Promise.resolve({
          data: ids.map((id) => ({
            id,
            address: `adresse ${id.slice(-3)}`,
            city: "Bordeaux",
            postal_code: "33000",
            source: "dvf",
          })),
          error: null,
        }),
    }),
  });
});

describe("comparables DVF détaillés (n° 23)", () => {
  it("refuse une vente non géocodée en 422, avec un message montrable", async () => {
    const failure = getDvfComparables({
      auth: authContext({ latitude: null }),
      input: dvfComparablesQuerySchema.parse({ saleId: SALE_ID }),
      now: NOW,
    });

    await expect(failure).rejects.toBeInstanceOf(PublicApiError);
    await expect(failure).rejects.toMatchObject({
      status: 422,
      message: "Comparables DVF indisponibles : la vente n'est pas géocodée.",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("interroge la recherche par segment et distance, pas une requête sans type de bien", async () => {
    await getDvfComparables({
      auth: authContext(),
      input: dvfComparablesQuerySchema.parse({ saleId: SALE_ID }),
      now: NOW,
    });

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "search_dvf_market_comparables",
      expect.objectContaining({
        p_segment: "apartment",
        p_radius_m: 1_000,
        p_latitude: 44.84,
        p_longitude: -0.58,
        p_minimum_date: "2023-10-31",
      }),
    );
    // Plus de lecture directe de la table, sauf pour l'adresse des lignes affichées.
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("dvf_transactions");
  });

  it("donne la même médiane et les mêmes quartiles pour limit=3 et limit=50", async () => {
    const run = (limit: number) =>
      getDvfComparables({
        auth: authContext(),
        input: dvfComparablesQuerySchema.parse({ saleId: SALE_ID, limit }),
        now: NOW,
      });

    const short = await run(3);
    const long = await run(50);

    expect(short.analysis.comparables).toHaveLength(3);
    expect(long.analysis.comparables.length).toBeGreaterThan(3);
    expect(short.analysis.medianPricePerM2).not.toBeNull();
    expect(short.analysis.medianPricePerM2).toBe(long.analysis.medianPricePerM2);
    expect(short.analysis.p25PricePerM2).toBe(long.analysis.p25PricePerM2);
    expect(short.analysis.p75PricePerM2).toBe(long.analysis.p75PricePerM2);
    expect(short.analysis.sampleSize).toBe(long.analysis.sampleSize);
    expect(short.analysis.medianValueEur).toBe(long.analysis.medianValueEur);
    expect(short.analysis.confidenceScore).toBe(long.analysis.confidenceScore);
  });

  it("complète l'adresse des seules lignes affichées", async () => {
    const response = await getDvfComparables({
      auth: authContext(),
      input: dvfComparablesQuerySchema.parse({ saleId: SALE_ID, limit: 3 }),
      now: NOW,
    });

    expect(mocks.from).toHaveBeenCalledTimes(1);
    for (const comparable of response.analysis.comparables) {
      expect(comparable.address).toMatch(/^adresse /);
      expect(comparable.city).toBe("Bordeaux");
      expect(comparable.distanceM).toBeGreaterThan(0);
    }
  });

  it("ignore les lignes qui ne sont pas des ventes", async () => {
    mocks.rpc.mockResolvedValue({
      data: rpcRows(10).map((row) => ({ ...row, mutation_nature: "Echange" })),
      error: null,
    });

    const response = await getDvfComparables({
      auth: authContext(),
      input: dvfComparablesQuerySchema.parse({ saleId: SALE_ID }),
      now: NOW,
    });

    expect(response.analysis.available).toBe(false);
    expect(response.scope.candidateCount).toBe(0);
  });

  it("remonte une panne de la base au lieu d'afficher une analyse vide", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "timeout" } });

    await expect(
      getDvfComparables({
        auth: authContext(),
        input: dvfComparablesQuerySchema.parse({ saleId: SALE_ID }),
        now: NOW,
      }),
    ).rejects.toThrow(/Comparables DVF indisponibles : timeout/);
  });
});
