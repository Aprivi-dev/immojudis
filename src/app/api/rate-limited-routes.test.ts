import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforceUser: vi.fn(),
  enforceIp: vi.fn(),
  entitlement: vi.fn(),
  refreshValuation: vi.fn(),
  listDirectory: vi.fn(),
  createReferral: vi.fn(),
  createPrivacy: vi.fn(),
  dvf: vi.fn(),
  environment: vi.fn(),
  featured: vi.fn(),
  boundary: vi.fn(),
  checkout: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: mocks.enforceUser,
  enforceIpRateLimit: mocks.enforceIp,
}));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: mocks.entitlement }));
vi.mock("@/lib/sale-market-estimates", () => ({
  refreshSaleValuationOnDemand: mocks.refreshValuation,
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/lib/lawyer-directory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lawyer-directory")>()),
  listLawyerDirectory: mocks.listDirectory,
}));
vi.mock("@/lib/lawyer-referrals", () => ({
  createLawyerReferralRequest: mocks.createReferral,
  listLawyerReferralRequests: vi.fn(),
  lawyerReferralListQuerySchema: { parse: (value: unknown) => value },
  lawyerReferralRequestInputSchema: { parse: (value: unknown) => value },
}));
vi.mock("@/lib/privacy-requests", () => ({
  createPrivacyRequest: mocks.createPrivacy,
  listPrivacyRequests: vi.fn(),
  privacyRequestInputSchema: { parse: (value: unknown) => value },
}));
vi.mock("@/lib/dvf-comparables", () => ({
  dvfComparablesQuerySchema: { parse: (value: unknown) => value },
  getDvfComparables: mocks.dvf,
}));
vi.mock("@/lib/environment.functions", () => ({
  environmentalContextCacheControl: () => "private, no-store",
  getEnvironmentalContext: mocks.environment,
}));
vi.mock("@/lib/featured-lawyers", () => ({
  featuredLawyerQuerySchema: { parse: (value: unknown) => value },
  getFeaturedReferencedLawyerForSale: mocks.featured,
}));
vi.mock("@/lib/geographic-boundary", () => ({
  fetchGeographicBoundary: mocks.boundary,
  GeographicBoundaryUpstreamError: class extends Error {},
}));
vi.mock("@/lib/billing", () => ({
  resolveAnalysisCheckoutAvailability: mocks.checkout,
}));

import { POST as marketEstimate } from "./market-estimate/route";
import { GET as directory } from "./lawyers/directory/route";
import { POST as referralPost } from "./lawyer-referrals/route";
import { POST as privacyPost } from "./privacy/requests/route";
import { GET as dvfGet } from "./dvf-comparables/route";
import { POST as environmentPost } from "./environment-context/route";
import { GET as featuredGet } from "./lawyers/featured/route";
import { GET as boundaryGet } from "./geographic-boundary/route";
import { GET as offerGet } from "./billing/offer/route";
import { LAWYER_DIRECTORY_PAGE_SIZE } from "@/lib/rate-limit-policies";

const saleId = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown) =>
  new Request("https://example.test/api/x", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const visibleSale = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  visibleSale.select.mockReturnValue(visibleSale);
  visibleSale.eq.mockReturnValue(visibleSale);
  visibleSale.maybeSingle.mockResolvedValue({ data: { id: saleId }, error: null });
  mocks.auth.mockResolvedValue({ userId: "user-1", supabase: { from: () => visibleSale } });
  mocks.enforceUser.mockResolvedValue(1);
  mocks.enforceIp.mockResolvedValue(undefined);
  mocks.entitlement.mockResolvedValue({ plan: "analyse" });
});

describe("P4-02 rate limits on costly and public routes", () => {
  it("rejects the 31st market-estimate call of the minute with 429 and Retry-After", async () => {
    let calls = 0;
    mocks.enforceUser.mockImplementation(async () => {
      calls += 1;
      if (calls > 30) throw new RateLimitError(undefined, 21);
      return calls;
    });
    mocks.refreshValuation.mockResolvedValue({ estimate: null, status: "queued" });

    let last: Response | null = null;
    for (let call = 1; call <= 31; call += 1) last = await marketEstimate(json({ saleId }));

    expect(mocks.enforceUser).toHaveBeenLastCalledWith({
      userId: "user-1",
      bucketKey: "market-estimate",
      limit: 30,
      windowSeconds: 60,
    });
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBe("21");
    expect(mocks.refreshValuation).toHaveBeenCalledTimes(30);
  });

  it("never returns more than 50 lawyer profiles per directory call and caches the page", async () => {
    mocks.listDirectory.mockImplementation(async (query: { page: number }) => {
      const { paginateLawyerDirectory } = await import("@/lib/lawyer-directory");
      const everyone = Array.from({ length: 180 }, (_, index) => ({ id: `lawyer-${index}` }));
      const page = paginateLawyerDirectory(everyone, query.page);
      return { lawyers: page.items, pagination: page.pagination };
    });

    const first = await directory(new Request("https://example.test/api/lawyers/directory"));
    const last = await directory(new Request("https://example.test/api/lawyers/directory?page=4"));
    const body = await first.json();

    expect(body.lawyers).toHaveLength(LAWYER_DIRECTORY_PAGE_SIZE);
    expect(body.pagination).toEqual({ page: 1, pageSize: 50, total: 180, hasMore: true });
    expect((await last.json()).lawyers).toHaveLength(30);
    expect(first.headers.get("cache-control")).toContain("s-maxage=3600");
  });

  it("limits the public directory, featured lawyer, boundary and offer routes per IP", async () => {
    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 9));
    const get = (path: string) => new Request(`https://example.test${path}`);

    const responses = await Promise.all([
      directory(get("/api/lawyers/directory")),
      featuredGet(get(`/api/lawyers/featured?saleId=${saleId}`)),
      boundaryGet(get("/api/geographic-boundary?label=Bordeaux")),
      offerGet(get("/api/billing/offer")),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("9");
    }
    expect(mocks.listDirectory).not.toHaveBeenCalled();
    expect(mocks.boundary).not.toHaveBeenCalled();
    expect(
      mocks.enforceIp.mock.calls.map(([options]) => [options.bucketKey, options.limit]),
    ).toEqual([
      ["lawyers.directory", 60],
      ["lawyers.featured", 60],
      ["geographic-boundary", 60],
      ["billing.offer", 60],
    ]);
  });

  it("allows 10 form submissions per hour for referrals and privacy requests", async () => {
    mocks.createReferral.mockResolvedValue({ reusedExisting: false });
    mocks.createPrivacy.mockResolvedValue({ ok: true });

    await referralPost(json({ any: "thing" }));
    await privacyPost(json({ any: "thing" }));

    expect(mocks.enforceUser).toHaveBeenCalledWith({
      userId: "user-1",
      bucketKey: "lawyer-referrals.create",
      limit: 10,
      windowSeconds: 3600,
    });
    expect(mocks.enforceUser).toHaveBeenCalledWith({
      userId: "user-1",
      bucketKey: "privacy-requests.create",
      limit: 10,
      windowSeconds: 3600,
    });

    mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 600));
    const blocked = await referralPost(json({ any: "thing" }));
    expect(blocked.status).toBe(429);
    expect(mocks.createReferral).toHaveBeenCalledTimes(1);
  });

  it("charges dvf-comparables and environment-context to the 30/min compute budget", async () => {
    mocks.dvf.mockResolvedValue({ analysis: { sampleSize: 1 } });
    mocks.environment.mockResolvedValue({});

    await dvfGet(
      new Request("https://example.test/api/dvf-comparables", {
        headers: { authorization: "Bearer t" },
      }),
    );
    await environmentPost(json({}));

    for (const bucketKey of ["dvf-comparables", "environment-context"]) {
      expect(mocks.enforceUser).toHaveBeenCalledWith({
        userId: "user-1",
        bucketKey,
        limit: 30,
        windowSeconds: 60,
      });
    }
  });

  it("answers billing/offer failures with a generic 503 and caches anonymous answers for 5 minutes", async () => {
    vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_test");
    const anonymous = await offerGet(new Request("https://example.test/api/billing/offer"));
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toContain("s-maxage=300");

    mocks.auth.mockRejectedValue(new Error("Stripe secret sk_live_123 rejected"));
    const failed = await offerGet(
      new Request("https://example.test/api/billing/offer", {
        headers: { authorization: "Bearer token" },
      }),
    );
    const body = await failed.json();
    expect(failed.status).toBe(503);
    expect(body.error).toBe("Offre indisponible.");
    expect(JSON.stringify(body)).not.toContain("sk_live");
    vi.unstubAllEnvs();
  });
});
