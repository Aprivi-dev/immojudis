import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  entitlement: vi.fn(),
  included: vi.fn(),
  refresh: vi.fn(),
  enforce: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlementVia: mocks.entitlement,
  featureIncludedForSale: mocks.included,
}));
vi.mock("@/lib/sale-market-estimates", () => ({ refreshSaleValuationOnDemand: mocks.refresh }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));

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
    mocks.included.mockResolvedValue(true);
    mocks.entitlement.mockResolvedValue({ plan: { plan: "decouverte" }, door: "unlock" });
    mocks.enforce.mockResolvedValue(1);
    mocks.record.mockResolvedValue(true);
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

  it("asks for the right of this very sale when the offer lacks the estimate", async () => {
    authWithVisibleSale(true);
    mocks.included.mockResolvedValue(false);
    mocks.refresh.mockResolvedValue({ ok: false, estimate: null, status: "queued" });

    await POST(request());

    expect(mocks.included).toHaveBeenCalledWith(
      expect.anything(),
      "property.valueEstimate",
      saleId,
    );
    // An unlock opens the bid ceiling, never the autonomous estimate.
    expect(mocks.entitlement).toHaveBeenCalledWith(
      expect.anything(),
      "property.bidCeiling",
      expect.any(String),
      { saleId },
    );
  });

  it("refuses an account that has neither the offer nor the unlock of this sale", async () => {
    authWithVisibleSale(true);
    mocks.included.mockResolvedValue(false);
    mocks.entitlement.mockRejectedValue(
      Object.assign(new Error("Estimation de marché réservée au plan Analyse."), { status: 403 }),
    );

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  describe("estimate sent", () => {
    const estimate = {
      source: "DVF normalisé",
      sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
      estimatedValueEur: 210_000,
      estimatedValueLowEur: 190_000,
      estimatedValueHighEur: 230_000,
      actionable: true,
      sampleSize: 14,
      effectiveSampleSize: 9,
      qualityLabel: "correcte",
      medianPricePerM2: 3_500,
      p10PricePerM2: 2_800,
      p25PricePerM2: 3_100,
      p75PricePerM2: 3_900,
      p90PricePerM2: 4_300,
      minPricePerM2: 2_500,
      maxPricePerM2: 4_800,
      recentTransactions: [{ date: "2025-02-01", pricePerM2: 3_400 }],
      addressHistory: [],
      commune: "Lyon",
    };

    beforeEach(() => {
      mocks.refresh.mockResolvedValue({
        ok: true,
        error: null,
        estimate,
        status: "ready",
        computedAt: "2026-10-01T00:00:00.000Z",
      });
    });

    it("sends Analyse the whole estimate, read through the full catalogue view", async () => {
      const { from } = authWithVisibleSale(true);

      const body = await (await POST(request())).json();

      expect(from).toHaveBeenCalledWith("v_auction_sales_app");
      expect(body.estimate).toEqual(estimate);
      expect(mocks.entitlement).not.toHaveBeenCalled();
    });

    it("measures, for the account, that the reference value of the ceiling was served", async () => {
      authWithVisibleSale(true);

      await POST(request());

      expect(mocks.record).toHaveBeenCalledTimes(1);
      expect(mocks.record).toHaveBeenCalledWith("user-1", {
        type: "bid_ceiling_calculated",
        saleId,
      });
    });

    it("sends an unlocked sale only what the bid ceiling reads, through the discovery view", async () => {
      const { from } = authWithVisibleSale(true);
      mocks.included.mockResolvedValue(false);

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(from).toHaveBeenCalledWith("v_auction_sales_discovery");
      expect(from).not.toHaveBeenCalledWith("v_auction_sales_app");
      expect(body.estimate).toEqual({
        source: "DVF normalisé",
        sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
        subjectSurfaceEstimated: false,
        estimatedValueEur: 210_000,
        actionable: true,
        qualityLabel: "correcte",
        sampleSize: 9,
        medianPricePerM2: 3_500,
        p75PricePerM2: 3_900,
      });
      expect(body.computedAt).toBe("2026-10-01T00:00:00.000Z");
      expect(JSON.stringify(body)).not.toMatch(
        /recentTransactions|addressHistory|p10PricePerM2|p90PricePerM2|HighEur|LowEur|commune/,
      );
    });
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
    // Pas de valeur de référence servie : rien n'est mesuré.
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
