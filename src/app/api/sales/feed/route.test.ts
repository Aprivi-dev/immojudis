import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { occupancyClassCodes } from "@/lib/occupancy-filter";
import { occupancyClass } from "@/lib/occupancy-status";
import type { SaleFilters } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  apiKeyAuth: vi.fn(),
  plan: vi.fn(),
  getSales: vi.fn(),
}));

vi.mock("@/lib/api-keys", () => ({ apiKeyAuthContextFromRequest: mocks.apiKeyAuth }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => null,
  requireSupabaseAuthContext: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: null, error: null }),
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        limit: async () => ({ data: [], error: null }),
        insert: async () => ({ error: null }),
      };
      return query;
    },
  },
}));
vi.mock("@/lib/entitlements.server", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  enforceUserRateLimit: vi.fn(),
  enforceDailyOperationLimits: vi.fn(),
}));
vi.mock("@/lib/queries", () => ({ getSales: mocks.getSales }));
vi.mock("@/lib/sale-publication-guard", () => ({
  getPublicationVisibleSaleIds: async (ids: string[]) => new Set(ids),
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));

import { GET } from "./route";

const CATALOGUE = [
  { id: "libre", occupancy_status: "vacant", property_type: "apartment" },
  { id: "occupee", occupancy_status: "occupied", property_type: "apartment" },
  { id: "box", occupancy_status: "unknown", property_type: "parking" },
].map((sale) => ({ ...EXAMPLE_SALE, ...sale }));

async function feed(query: string) {
  const response = await GET(new Request(`https://immojudis.com/api/sales/feed?${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: Array<{ id: string }>;
    meta: { filters: Record<string, unknown> };
  };
}

// Avant le lot 12, la route lisait l'adresse sans `catalogueSearch` : une ancienne valeur de filtre
// d'une alerte ou d'une adresse partagée (`occupancy=free`, `homeTypes=garage`) ne rendait rien.
describe("GET /api/sales/feed : anciennes valeurs des filtres", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Le flux est réservé à l'administration (n° 97) : le rôle du titulaire de la clé compte.
    mocks.apiKeyAuth.mockResolvedValue({
      userId: "user-1",
      claims: { api_key_id: "key-1" },
      supabase: {},
      userRole: "admin",
    });
    mocks.plan.mockResolvedValue({ plan: "analyse" });
    // Comme la requête de la base (`queries.ts`) : la colonne comparée aux codes du filtre.
    mocks.getSales.mockImplementation(async (filters: SaleFilters) => {
      const occupancy = filters.occupancy_status && occupancyClass(filters.occupancy_status);
      const occupancyCodes = occupancy ? occupancyClassCodes(occupancy) : [];
      return CATALOGUE.filter(
        (sale) =>
          (!filters.occupancy_status || occupancyCodes.includes(sale.occupancy_status ?? "")) &&
          (!filters.property_type || sale.property_type === filters.property_type),
      );
    });
  });

  it("?occupancy=free rend les ventes libres", async () => {
    const body = await feed("occupancy=free");

    expect(body.data.map((item) => item.id)).toEqual(["libre"]);
    expect(body.meta.filters).toMatchObject({ occupancy: "vacant" });
  });

  it("?homeTypes=garage rend les parkings", async () => {
    const body = await feed("homeTypes=garage");

    expect(body.data.map((item) => item.id)).toEqual(["box"]);
  });
});
