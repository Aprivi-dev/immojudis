import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { validateSalesSearch } from "@/lib/search/search-url-state";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  getSales: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
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
vi.mock("@/lib/geo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geo")>()),
  geocodeAddress: vi.fn(),
}));
vi.mock("@/lib/sale-publication-guard", () => ({
  getPublicationVisibleSaleIds: async (ids: string[]) => new Set(ids),
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));

import { exportSalesApiFeed, exportSalesCsv } from "@/lib/sale-exports";

const request = new Request("https://immojudis.com/api/sales/export");
const auth = { userId: "user-1", claims: {}, supabase: {} } as unknown as SupabaseAuthContext;
// Le flux API est réservé à l'administration (n° 97).
const adminAuth = {
  userId: "user-1",
  claims: { api_key_id: "key-1" },
  supabase: {},
  userRole: "admin",
} as unknown as SupabaseAuthContext;
const search = validateSalesSearch({});

// Nom inventé, dans le titre et dans la synthèse.
const sale = {
  ...EXAMPLE_SALE,
  id: "sale-with-name",
  title: "Maison occupée par Monsieur Gaspard VERNOLET à Lyon",
  investment_summary: "Bien loué à Madame Kylia VERNOLET, loyer de 600 euros.",
  documents_rich: [
    {
      url: "https://example.test/pieces/PV_VERNOLET_Gaspard.pdf",
      label: "PV_VERNOLET_Gaspard.pdf",
      type: "pdf",
      extraction_status: null,
    },
  ],
};

describe("export CSV et flux API : filtre des noms de personnes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.plan.mockResolvedValue({ plan: "analyse" });
    mocks.getSales.mockResolvedValue([sale]);
  });

  it("ne laisse sortir aucun nom dans le CSV", async () => {
    const { content } = await exportSalesCsv({ auth, search, request });
    expect(content).toContain("Maison occupée par un occupant à Lyon");
    expect(content).not.toContain("VERNOLET");
    expect(content).not.toContain("Gaspard");
  });

  it("ne laisse sortir aucun nom dans le flux API", async () => {
    const feed = await exportSalesApiFeed({ auth: adminAuth, search, request });
    const [item] = feed.data;
    expect(item.title).toBe("Maison occupée par un occupant à Lyon");
    expect(item.scoring.summary).toBe("Bien loué à un locataire, loyer de 600 euros.");
    expect(item.documents.items[0].label).toBe("Pièce jointe");
    // L'adresse de la pièce reste celle de la source (elle n'est pas un texte affiché).
    expect(JSON.stringify({ ...item, documents: null })).not.toContain("VERNOLET");
  });
});
