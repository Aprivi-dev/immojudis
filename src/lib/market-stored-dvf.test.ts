import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const adminMock = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: adminMock,
}));

function queryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gt", "gte", "lte", "order", "limit"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => result);
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe("market estimate normalized DVF corpus", () => {
  beforeAll(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-test-key");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("prefers the recent normalized corpus and avoids a Cerema request", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => {
      const surface = 70 + index;
      return {
        id: `row-${index}`,
        source_mutation_id: `mutation-${index}`,
        sale_date: `2025-${String((index % 8) + 1).padStart(2, "0")}-15`,
        mutation_nature: "Vente",
        total_price_eur: surface * (3_500 + index * 35),
        built_surface_m2: surface,
        land_surface_m2: null,
        price_per_m2: 3_500 + index * 35,
        property_type: "Appartement",
        dvf_property_type_code: "121",
        parcel_id: `parcel-${index}`,
        latitude: 44.8378 + index * 0.00008,
        longitude: -0.5792 + index * 0.00008,
      };
    });
    adminMock.from.mockImplementation((table: string) => {
      if (table === "dvf_import_batches") {
        return queryBuilder({
          data: { status: "completed", imported_rows: rows.length, period_end: "2026-06-30" },
          error: null,
        });
      }
      if (table === "dvf_transactions") return queryBuilder({ data: rows, error: null });
      if (table === "valuation_model_versions") return queryBuilder({ data: null, error: null });
      throw new Error(`Unexpected table ${table}`);
    });

    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("geo.api.gouv.fr")) {
          return Response.json([{ nom: "Bordeaux", population: 260_000 }]);
        }
        throw new Error(`Cerema should not be queried: ${url}`);
      }),
    );

    const { getMarketEstimate } = await import("@/lib/market.functions");
    const response = await getMarketEstimate({
      lat: 44.8378,
      lng: -0.5792,
      propertyType: "apartment",
      surfaceM2: 75,
    });

    expect(response.estimate).toMatchObject({
      source: "DVF normalisé",
      engineVersion: "v3",
      segment: "apartment",
      medianPricePerM2: expect.any(Number),
    });
    expect(requestedUrls.every((url) => !url.includes("cerema.fr"))).toBe(true);
  });
});
