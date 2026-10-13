import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforce: vi.fn(),
  assertEntitlement: vi.fn(),
  getScenarios: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: mocks.assertEntitlement }));
vi.mock("@/lib/auction-scenarios.server", () => ({ getAuctionScenarios: mocks.getScenarios }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: mocks.recordUsage }));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";

function accountSeeing(visible: boolean) {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: visible ? { id: saleId } : null, error: null });
  const from = vi.fn().mockReturnValue(query);
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from } });
  return from;
}

const call = () =>
  GET(new Request(`https://example.test/api/sales/${saleId}/auction-scenarios`), {
    params: Promise.resolve({ id: saleId }),
  });

describe("GET /api/sales/[id]/auction-scenarios", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.enforce.mockResolvedValue(1);
    mocks.assertEntitlement.mockResolvedValue({ plan: "decouverte" });
    mocks.getScenarios.mockResolvedValue({ scenarios: null, history: {} });
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it("asks for the entitlement of this very sale, so an unlock opens that sale only", async () => {
    accountSeeing(true);

    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      expect.anything(),
      "property.advancedBidScenarios",
      expect.any(String),
      { saleId },
    );
  });

  it("refuses an account that neither subscribes nor unlocked this sale", async () => {
    mocks.assertEntitlement.mockRejectedValue(new Error("Les scénarios d’enchères sont réservés."));
    accountSeeing(true);

    const response = await call();

    expect(response.status).toBe(403);
    expect(mocks.getScenarios).not.toHaveBeenCalled();
  });

  it("answers 404 when the sale is not visible to the account", async () => {
    accountSeeing(false);

    expect((await call()).status).toBe(404);
    expect(mocks.getScenarios).not.toHaveBeenCalled();
  });
});
