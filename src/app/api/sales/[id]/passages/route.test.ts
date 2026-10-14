import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforce: vi.fn(),
  saleFeatureDoor: vi.fn(),
  getPassages: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/property-reports", () => ({ saleFeatureDoor: mocks.saleFeatureDoor }));
vi.mock("@/lib/sale-passages.server", () => ({ getSalePassages: mocks.getPassages }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: mocks.recordUsage }));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const passages = {
  access: "full" as const,
  summary: { previousPassageCount: 1, postponementCount: 0, priceChangePct: -20 },
  timeline: [],
  previousPassages: [{ saleDate: "2026-03-01", startingPriceEur: 100000 }],
};

function accountSeeing(views: Record<string, boolean>) {
  const from = vi.fn((view: string) => {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({
      data: views[view] ? { id: saleId, starting_price_eur: 80000 } : null,
      error: null,
    });
    return query;
  });
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from } });
  return from;
}

const call = () =>
  GET(new Request(`https://example.test/api/sales/${saleId}/passages`), {
    params: Promise.resolve({ id: saleId }),
  });

describe("GET /api/sales/[id]/passages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.enforce.mockResolvedValue(1);
    mocks.getPassages.mockResolvedValue(passages);
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it("serves the full history to Analyse, read through the full catalogue view", async () => {
    mocks.saleFeatureDoor.mockResolvedValue("plan");
    const from = accountSeeing({ v_auction_sales_app: true });

    const response = await call();

    expect(mocks.saleFeatureDoor).toHaveBeenCalledWith(
      expect.anything(),
      "property.saleHistory",
      saleId,
    );
    expect(from).toHaveBeenCalledWith("v_auction_sales_app");
    expect(await response.json()).toMatchObject({ access: "full" });
  });

  it("serves the full history of a sale the account unlocked, without the full view", async () => {
    mocks.saleFeatureDoor.mockResolvedValue("unlock");
    const from = accountSeeing({ v_auction_sales_discovery: true });

    const response = await call();

    expect(from).toHaveBeenCalledWith("v_auction_sales_discovery");
    expect(from).not.toHaveBeenCalledWith("v_auction_sales_app");
    expect(await response.json()).toMatchObject({ access: "full" });
    expect(mocks.getPassages).toHaveBeenCalledWith(saleId, 80000);
  });

  it("serves only the counts, without dates or prices, for a sale that is not unlocked", async () => {
    mocks.saleFeatureDoor.mockResolvedValue(null);
    accountSeeing({ v_auction_sales_discovery: true });

    const body = await (await call()).json();

    expect(body).toEqual({ access: "teaser", summary: passages.summary });
    expect(JSON.stringify(body)).not.toContain("2026-03-01");
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("answers 404 when the sale is not visible to the account", async () => {
    mocks.saleFeatureDoor.mockResolvedValue("unlock");
    accountSeeing({});

    expect((await call()).status).toBe(404);
    expect(mocks.getPassages).not.toHaveBeenCalled();
  });
});
