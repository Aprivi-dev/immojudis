import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforce: vi.fn(),
  featureIncludedForSale: vi.fn(),
  getReading: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/property-reports", () => ({ featureIncludedForSale: mocks.featureIncludedForSale }));
vi.mock("@/lib/document-reading.server", () => ({ getDocumentReading: mocks.getReading }));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const reading = {
  access: "full" as const,
  status: "completed" as const,
  generatedAt: "2026-10-12T08:00:00Z",
  partial: false,
  points: [
    {
      theme: "occupation" as const,
      importance: "alerte" as const,
      title: "Bien occupé",
      explanation: null,
      quote: "occupé par un occupant",
      page: 2,
      document: null,
    },
  ],
};

function accountSeeing(views: Record<string, boolean>) {
  const from = vi.fn((view: string) => {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: views[view] ? { id: saleId } : null, error: null });
    return query;
  });
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from } });
  return from;
}

const call = () =>
  GET(new Request(`https://example.test/api/sales/${saleId}/document-reading`), {
    params: Promise.resolve({ id: saleId }),
  });

describe("GET /api/sales/[id]/document-reading", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.enforce.mockResolvedValue(1);
    mocks.getReading.mockResolvedValue(reading);
  });

  it("serves the verified points on a sale the account unlocked", async () => {
    mocks.featureIncludedForSale.mockResolvedValue(true);
    const from = accountSeeing({ v_auction_sales_app: true });

    const response = await call();

    expect(mocks.featureIncludedForSale).toHaveBeenCalledWith(
      expect.anything(),
      "property.documentReading",
      saleId,
    );
    expect(from).toHaveBeenCalledWith("v_auction_sales_app");
    expect(await response.json()).toMatchObject({ access: "full", points: [{ page: 2 }] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves only the counts to an account that did not unlock this sale", async () => {
    mocks.featureIncludedForSale.mockResolvedValue(false);
    const from = accountSeeing({ v_auction_sales_discovery: true });

    const response = await call();
    const body = await response.json();

    expect(from).toHaveBeenCalledWith("v_auction_sales_discovery");
    expect(body).toEqual({
      access: "teaser",
      pointCount: 1,
      alertCount: 1,
      themes: ["occupation"],
    });
    expect(JSON.stringify(body)).not.toContain("occupé par");
  });

  it("answers 404 when the unlocked sale is no longer visible, without reading the reading", async () => {
    mocks.featureIncludedForSale.mockResolvedValue(true);
    accountSeeing({ v_auction_sales_app: false });

    const response = await call();

    expect(response.status).toBe(404);
    expect(mocks.getReading).not.toHaveBeenCalled();
  });
});
