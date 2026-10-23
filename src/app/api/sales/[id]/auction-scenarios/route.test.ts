import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforce: vi.fn(),
  assertEntitlement: vi.fn(),
  getScenarios: vi.fn(),
  recordUsage: vi.fn(),
  after: vi.fn(),
}));

// `after()` only exists inside a request: the test keeps the callbacks and runs them by hand.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlementVia: mocks.assertEntitlement }));
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
    mocks.assertEntitlement.mockResolvedValue({ plan: { plan: "decouverte" }, door: "unlock" });
    mocks.getScenarios.mockResolvedValue({ scenarios: null, history: {} });
    mocks.recordUsage.mockResolvedValue(undefined);
    mocks.after.mockImplementation(() => undefined);
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

  it("reads the sale through the discovery view for an unlock, the full view for Analyse", async () => {
    const unlocked = accountSeeing(true);
    await call();
    expect(unlocked).toHaveBeenCalledWith("v_auction_sales_discovery");
    expect(unlocked).not.toHaveBeenCalledWith("v_auction_sales_app");

    mocks.assertEntitlement.mockResolvedValue({ plan: { plan: "analyse" }, door: "plan" });
    const analysis = accountSeeing(true);
    await call();
    expect(analysis).toHaveBeenCalledWith("v_auction_sales_app");
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

  it("starts the entitlement check and the rate limit together, then reads the sale", async () => {
    accountSeeing(true);
    const order: string[] = [];
    let release: () => void = () => undefined;
    mocks.assertEntitlement.mockImplementation(async () => {
      order.push("entitlement:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("entitlement:end");
      return { plan: { plan: "analyse" }, door: "plan" };
    });
    mocks.enforce.mockImplementation(async () => {
      order.push("rate-limit");
      release();
      return 1;
    });

    expect((await call()).status).toBe(200);

    // The rate limit ran while the entitlement check was still waiting.
    expect(order).toEqual(["entitlement:start", "rate-limit", "entitlement:end"]);
  });

  it("answers 403, not 429, when the account has no right and is also over the limit", async () => {
    accountSeeing(true);
    mocks.assertEntitlement.mockRejectedValue(new Error("Les scénarios d’enchères sont réservés."));
    mocks.enforce.mockRejectedValue(new Error("rate limited"));

    expect((await call()).status).toBe(403);
    expect(mocks.getScenarios).not.toHaveBeenCalled();
  });

  it("reads the cached figures only after the sale is known to be visible", async () => {
    accountSeeing(false);
    await call();
    expect(mocks.getScenarios).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not select the surface of the sale any more", async () => {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: { id: saleId }, error: null });
    mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from: vi.fn(() => query) } });

    await call();

    const columns = query.select.mock.calls[0][0] as string;
    expect(columns).toContain("property_type");
    expect(columns).not.toMatch(/surface/);
  });

  it("records the usage event after the response, not before", async () => {
    accountSeeing(true);
    mocks.getScenarios.mockResolvedValue({
      scenarios: { courtSample: 12 },
      history: { dvf: { sample: 5 } },
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "sales.statistics_viewed",
        subjectId: saleId,
        metadata: { view: "auction_scenarios", court_sample: 12, dvf_sample: 5 },
      }),
    );
  });

  it("never turns a failing usage event into an error response", async () => {
    accountSeeing(true);
    mocks.recordUsage.mockRejectedValue(new Error("insert failed"));
    expect((await call()).status).toBe(200);
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();

    // A synchronous throw inside the callback, too.
    mocks.recordUsage.mockImplementation(() => {
      throw new Error("sync failure");
    });
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
  });

  it("answers normally when after() itself throws (outside a request)", async () => {
    accountSeeing(true);
    mocks.after.mockImplementation(() => {
      throw new Error("after() was called outside a request scope");
    });
    expect((await call()).status).toBe(200);
  });
});
