import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforce: vi.fn(),
  saleFeatureDoor: vi.fn(),
  estimate: vi.fn(),
  publicationVisible: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/entitlements.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements.server")>()),
  saleFeatureDoor: mocks.saleFeatureDoor,
}));
vi.mock("@/lib/sale-publication-guard", () => ({
  assertSalePublicationVisible: mocks.publicationVisible,
}));
vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: mocks.estimate }));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const otherSaleId = "22222222-2222-4222-8222-222222222222";
const estimate = {
  actionable: true,
  estimatedValueEur: 201_400,
  estimatedValueLowEur: 178_650,
  estimatedValueHighEur: 224_300,
  qualityLabel: "correcte",
  sampleSize: 14,
  radiusM: 600,
};

function accountSeeing(
  views: Record<string, boolean>,
  band: { data: unknown; error: unknown } = { data: "under", error: null },
) {
  const from = vi.fn((view: string) => {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({
      data: views[view]
        ? { id: saleId, starting_price_eur: 140_000, occupancy_status: "vacant" }
        : null,
      error: null,
    });
    return query;
  });
  const rpc = vi.fn().mockResolvedValue(band);
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from, rpc } });
  return { from, rpc };
}

const call = (id = saleId) =>
  GET(new Request(`https://example.test/api/sales/${id}/value-preview`), {
    params: Promise.resolve({ id }),
  });

/** No value, range or gap figure: the only numbers allowed are the comparable count and radius. */
function expectNoValueFigure(body: Record<string, unknown>) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(
    /lowEur|highEur|discountPct|startingPricePerM2|estimatedValue|reliability/,
  );
  for (const figure of ["179000", "224000", "201400", "140000"]) expect(text).not.toContain(figure);
}

describe("GET /api/sales/[id]/value-preview", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.enforce.mockResolvedValue(1);
    mocks.estimate.mockResolvedValue(estimate);
    mocks.publicationVisible.mockResolvedValue(undefined);
  });

  it("serves the range and the gap to Analyse, read through the full catalogue view", async () => {
    mocks.saleFeatureDoor.mockResolvedValue("plan");
    const { from } = accountSeeing({ v_auction_sales_app: true });

    const response = await call();
    const body = await response.json();

    expect(mocks.saleFeatureDoor).toHaveBeenCalledWith(
      expect.anything(),
      "property.valueEstimate",
      saleId,
    );
    expect(from).toHaveBeenCalledWith("v_auction_sales_app");
    expect(body).toMatchObject({ access: "full", available: true, lowEur: 179_000 });
    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=300, stale-while-revalidate=3600",
    );
  });

  it("serves the range and the gap of the sale a free account unlocked", async () => {
    mocks.saleFeatureDoor.mockResolvedValue("unlock");
    const { from, rpc } = accountSeeing({ v_auction_sales_unlocked: true });

    const response = await call();
    const body = await response.json();

    // The right can end (unlock returned, sale withdrawn): the browser keeps no copy.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(from).toHaveBeenCalledWith("v_auction_sales_unlocked");
    expect(from).not.toHaveBeenCalledWith("v_auction_sales_app");
    expect(body).toMatchObject({
      access: "full",
      available: true,
      lowEur: 179_000,
      highEur: 224_000,
      discountPct: expect.any(Number),
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("serves a free account without the unlock only the band and the size of the sample", async () => {
    mocks.saleFeatureDoor.mockResolvedValue(null);
    const { from, rpc } = accountSeeing({ v_auction_sales_discovery: true });

    const response = await call();
    const body = await response.json();

    expect(from).toHaveBeenCalledWith("v_auction_sales_discovery");
    expect(rpc).toHaveBeenCalledWith("get_public_sale_market_gap_band", { p_sale_id: saleId });
    expect(body).toEqual({
      access: "teaser",
      band: "under",
      comparables: { count: 14, radiusM: 600 },
    });
    expectNoValueFigure(body);
    // Not kept by the browser: after an unlock, the next read is the full one.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("opens the unlocked sale X only: the sale Y of the same account stays a teaser", async () => {
    mocks.saleFeatureDoor.mockImplementation(async (_auth, _feature, id: string) =>
      id === saleId ? "unlock" : null,
    );
    accountSeeing({ v_auction_sales_unlocked: true, v_auction_sales_discovery: true });

    const opened = await (await call(saleId)).json();
    const closed = await (await call(otherSaleId)).json();

    expect(opened.access).toBe("full");
    expect(closed.access).toBe("teaser");
    expectNoValueFigure(closed);
  });

  it("gives no band rather than a figure when the band is unknown or the database fails", async () => {
    mocks.saleFeatureDoor.mockResolvedValue(null);
    accountSeeing({ v_auction_sales_discovery: true }, { data: "bogus", error: null });
    expect((await (await call()).json()).band).toBeNull();

    accountSeeing(
      { v_auction_sales_discovery: true },
      { data: null, error: { code: "57014", message: "timeout" } },
    );
    const body = await (await call()).json();
    expect(body).toEqual({
      access: "teaser",
      band: null,
      comparables: { count: 14, radiusM: 600 },
    });
  });

  it("gives no comparables without a stored estimate", async () => {
    mocks.saleFeatureDoor.mockResolvedValue(null);
    mocks.estimate.mockResolvedValue(null);
    accountSeeing({ v_auction_sales_discovery: true }, { data: null, error: null });

    expect(await (await call()).json()).toEqual({
      access: "teaser",
      band: null,
      comparables: null,
    });
  });

  it("answers 404 for a sale the account does not see, or a quarantined one", async () => {
    mocks.saleFeatureDoor.mockResolvedValue(null);
    accountSeeing({});
    expect((await call()).status).toBe(404);

    accountSeeing({ v_auction_sales_discovery: true });
    mocks.publicationVisible.mockRejectedValue(new NotFoundError("Vente introuvable."));
    expect((await call()).status).toBe(404);
    expect(mocks.estimate).not.toHaveBeenCalled();
  });
});
