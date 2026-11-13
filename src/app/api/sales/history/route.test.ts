import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  publicationVisible: vi.fn(),
  serviceRole: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: vi.fn() }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/lib/sale-publication-guard", () => ({
  assertSalePublicationVisible: mocks.publicationVisible,
}));
// Aucune lecture du service ne doit suivre pour une vente masquée.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.serviceRole, rpc: mocks.serviceRole },
}));

import { GET } from "./route";

const saleId = "6f0f8d0e-6b1e-4b5e-9a39-0d7a4c1a1b11";

describe("GET /api/sales/history : vente de référence en quarantaine", () => {
  let from: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Une session d'administrateur passe la sécurité par ligne : la vue lui rend la vente.
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({
      data: {
        id: saleId,
        city: "Bordeaux",
        department: "33",
        property_type: "apartment",
        latitude: 44.84,
        longitude: -0.58,
      },
      error: null,
    });
    from = vi.fn(() => query);
    mocks.auth.mockResolvedValue({ userId: "admin-1", isAdmin: true, supabase: { from } });
    mocks.publicationVisible.mockRejectedValue(
      new NotFoundError("Vente introuvable ou inaccessible."),
    );
  });

  it("répond 404 sans rien calculer sur la vente", async () => {
    const response = await GET(
      new Request(`https://example.test/api/sales/history?saleId=${saleId}`),
    );

    expect(response.status).toBe(404);
    expect(mocks.publicationVisible).toHaveBeenCalledWith(saleId);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("v_auction_sales_app");
    expect(mocks.serviceRole).not.toHaveBeenCalled();
  });
});
