import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { validateSalesSearch } from "@/lib/search/search-url-state";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  getSales: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (name: string) => mocks.rpc(name),
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
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  enforceUserRateLimit: vi.fn(),
  enforceDailyOperationLimits: vi.fn(),
}));
vi.mock("@/lib/queries", () => ({ getSales: mocks.getSales }));
vi.mock("@/lib/geo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geo")>()),
  geocodeAddress: vi.fn(),
}));
vi.mock("@/lib/sale-publication-guard", () => ({
  getPublicationVisibleSaleIds: async (ids: string[]) => new Set(ids),
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));

import { exportSalesApiFeed } from "@/lib/sale-exports";

const request = new Request("https://immojudis.com/api/sales/feed");
const auth = { userId: "user-1", claims: {}, supabase: {} } as unknown as SupabaseAuthContext;
const catalogue = ["Sale-A", "sale-b", "sale-c"].map((id) => ({
  ...EXAMPLE_SALE,
  // L'exemple est occupé ; « sous la fourchette » écarte toujours un bien occupé.
  occupancy_status: "unknown",
  id: id.toLowerCase(),
}));

const feedIds = async (search: Record<string, unknown>) =>
  (await exportSalesApiFeed({ auth, search: validateSalesSearch(search), request })).data.map(
    (item) => item.id,
  );

describe("flux /api/sales/feed : filtres « Pépites seulement » et « sous la fourchette » (n° 32)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.plan.mockResolvedValue({ plan: "analyse" });
    mocks.getSales.mockResolvedValue(catalogue);
    mocks.rpc.mockImplementation(async (name: string) => ({
      data:
        name === "list_public_pepite_sale_ids"
          ? ["sale-a", "SALE-C"]
          : name === "list_public_sale_ids_under_market_range"
            ? ["sale-b"]
            : null,
      error: null,
    }));
  });

  it("?pepite=1 ne rend que les pépites de la liste publique", async () => {
    expect(await feedIds({ pepite: "1" })).toEqual(["sale-a", "sale-c"]);
    expect(mocks.rpc).toHaveBeenCalledWith("list_public_pepite_sale_ids");
    expect(mocks.rpc).not.toHaveBeenCalledWith("list_public_sale_ids_under_market_range");
  });

  it("?belowRange=1 ne rend que les ventes de la liste « sous la fourchette »", async () => {
    expect(await feedIds({ belowRange: "1" })).toEqual(["sale-b"]);
    expect(mocks.rpc).not.toHaveBeenCalledWith("list_public_pepite_sale_ids");
  });

  it("sans filtre, aucune liste n'est lue", async () => {
    expect(await feedIds({})).toHaveLength(3);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("une panne de la liste des pépites est une erreur, jamais « aucune vente »", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(feedIds({ pepite: "1" })).rejects.toMatchObject({ code: "57014" });
    await expect(feedIds({ belowRange: "1" })).rejects.toMatchObject({ code: "57014" });
  });

  it("une base sans la fonction des pépites (migration pas appliquée) : aucune pépite", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect(await feedIds({ pepite: "1" })).toEqual([]);
  });
});
