import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  entitlement: vi.fn(),
  refresh: vi.fn(),
  enforce: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: mocks.entitlement }));
vi.mock("@/lib/sale-market-estimates", () => ({ refreshSaleValuationOnDemand: mocks.refresh }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));

import { POST } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const request = () =>
  new Request("https://example.test/api/market-estimate", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify({ saleId }),
  });

function authWithVisibleSale(visible: boolean) {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: visible ? { id: saleId } : null, error: null });
  const from = vi.fn().mockReturnValue(query);
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from } });
  return { from, query };
}

describe("POST /api/market-estimate sale readiness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.entitlement.mockResolvedValue({ plan: "analyse" });
    mocks.enforce.mockResolvedValue(1);
  });

  it("applies the sale page visibility rule before computing anything", async () => {
    const { from, query } = authWithVisibleSale(false);

    const response = await POST(request());

    expect(from).toHaveBeenCalledWith("v_auction_sales_app");
    expect(query.eq).toHaveBeenCalledWith("id", saleId);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Vente introuvable." });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("estimates a sale that is visible to the user", async () => {
    authWithVisibleSale(true);
    mocks.refresh.mockResolvedValue({
      ok: false,
      estimate: null,
      status: "queued",
      retryAfterSeconds: 30,
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(mocks.refresh).toHaveBeenCalledWith(saleId);
  });
});
