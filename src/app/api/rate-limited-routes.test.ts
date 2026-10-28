import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforceUser: vi.fn(),
  enforceIp: vi.fn(),
  enforceDaily: vi.fn(),
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
  pepiteRpc: vi.fn(),
  pepitePublished: vi.fn(),
  pepiteRead: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: mocks.enforceUser,
  enforceIpRateLimit: mocks.enforceIp,
  enforceDailyOperationLimits: mocks.enforceDaily,
}));
vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.entitlement,
  assertFeatureEntitlementVia: mocks.entitlement,
  featureIncludedForSale: async () => true,
}));
vi.mock("@/lib/sale-market-estimates", () => ({
  refreshSaleValuationOnDemand: mocks.refreshValuation,
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/lib/account-product-events.server", () => ({ recordAccountProductEvent: vi.fn() }));
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
vi.mock("@/lib/environmental-context", () => ({
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
vi.mock("next/cache", () => ({
  unstable_cache: (load: (...args: unknown[]) => unknown) => load,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: () => ({ rpc: mocks.pepiteRpc }),
}));
vi.mock("@/lib/sale-pepite.server", () => ({
  isPublishedPepite: mocks.pepitePublished,
  readStoredPepite: mocks.pepiteRead,
}));
vi.mock("@/lib/billing", () => ({
  resolveAnalysisCheckoutAvailability: mocks.checkout,
}));
vi.mock("@/lib/analysis-checkout-readiness", () => ({
  analysisCheckoutReadiness: () => ({ open: true, missing: [], launchOfferActive: false }),
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
import { GET as pepiteGet } from "./sales/[id]/pepite/route";
import { GET as pepiteIdsGet } from "./catalogue/pepites/route";
import { GET as v1OutcomeGraph } from "./v1/sales/[id]/outcome-graph/route";
import { GET as v1SaleAdjudicationStatistics } from "./v1/sales/[id]/adjudication-statistics/route";
import { GET as v1SaleUrbanismeCadastre } from "./v1/sales/[id]/urbanisme-cadastre/route";
import { GET as v1JudicialActivity } from "./v1/tribunals/judicial-activity/route";
import { GET as v1JudicialActivityDirectory } from "./v1/tribunals/judicial-activity/directory/route";
import { GET as v1TribunalStatistics } from "./v1/tribunals/statistics/route";
import { GET as v1ListingStatistics } from "./v1/tribunals/listing-statistics/route";
import { GET as v1AuctionSummaries } from "./v1/tribunals/auction-summaries/route";
import { GET as v1AdjudicationStatistics } from "./v1/tribunals/adjudication-statistics/route";
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
  mocks.enforceDaily.mockResolvedValue(undefined);
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

  it("limits the pepite routes (criteria, detail, public list): 429, Retry-After, no cache, and no read of the table", async () => {
    mocks.enforceIp.mockRejectedValue(new RateLimitError(undefined, 11));
    mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 13));
    const params = { params: Promise.resolve({ id: saleId }) };
    const get = (path: string, headers: HeadersInit = {}) =>
      new Request(`https://example.test${path}`, { headers });

    const criteria = await pepiteGet(get(`/api/sales/${saleId}/pepite`), params);
    const detail = await pepiteGet(
      get(`/api/sales/${saleId}/pepite?view=detail`, { authorization: "Bearer token" }),
      params,
    );
    const list = await pepiteIdsGet(get("/api/catalogue/pepites"));

    expect(criteria.status).toBe(429);
    expect(criteria.headers.get("retry-after")).toBe("11");
    expect(detail.status).toBe(429);
    expect(detail.headers.get("retry-after")).toBe("13");
    expect(list.status).toBe(429);
    expect(list.headers.get("retry-after")).toBe("11");
    // Aucun cache sur un refus : ni partagé, ni privé réutilisable.
    for (const response of [criteria, detail, list]) {
      expect(response.headers.get("cache-control")).toMatch(/no-store/);
      expect(response.headers.get("cache-control")).not.toMatch(/s-maxage|max-age=[1-9]/);
    }
    // Rien n'est lu : ni la fonction publique, ni la table privée, ni le droit.
    expect(mocks.pepitePublished).not.toHaveBeenCalled();
    expect(mocks.pepiteRead).not.toHaveBeenCalled();
    expect(mocks.pepiteRpc).not.toHaveBeenCalled();
    expect(mocks.entitlement).not.toHaveBeenCalled();
    expect(
      mocks.enforceIp.mock.calls.map(([options]) => [options.bucketKey, options.limit]),
    ).toEqual([
      ["sale-pepite", 60],
      ["catalogue.pepites", 180],
    ]);
    expect(mocks.enforceUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", bucketKey: "sale-pepite", limit: 30 }),
    );
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

  it("caps environment-context per day, only for an entitled account, with the daily message", async () => {
    mocks.environment.mockResolvedValue({});
    await environmentPost(json({}));
    expect(mocks.enforceDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        operation: "environmentContext",
        launchOffer: false,
      }),
    );
    // Droit issu de l'offre de lancement : le compteur propre à l'offre s'applique aussi.
    mocks.entitlement.mockResolvedValue({ plan: "analyse", launchOffer: true });
    await environmentPost(json({}));
    expect(mocks.enforceDaily).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "environmentContext", launchOffer: true }),
    );
    mocks.entitlement.mockResolvedValue({ plan: "analyse" });

    mocks.enforceDaily.mockRejectedValue(
      new RateLimitError(undefined, 3600, "Limite quotidienne atteinte, réessayez demain."),
    );
    mocks.environment.mockClear();
    const blocked = await environmentPost(json({}));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3600");
    expect(await blocked.json()).toMatchObject({
      error: "Limite quotidienne atteinte, réessayez demain.",
      code: "RATE_LIMITED",
    });
    expect(mocks.environment).not.toHaveBeenCalled();

    // Sans droit d'accès : refusé avant le plafond, qui n'est pas consommé.
    mocks.enforceDaily.mockClear();
    mocks.entitlement.mockRejectedValue(
      new Error("Contexte environnemental réservé à l’offre Analyse."),
    );
    expect((await environmentPost(json({}))).status).toBe(403);
    expect(mocks.enforceDaily).not.toHaveBeenCalled();
  });

  it("answers billing/offer failures with a generic 503 and caches anonymous answers for 5 minutes", async () => {
    const anonymous = await offerGet(new Request("https://example.test/api/billing/offer"));
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toContain("s-maxage=300");

    // Le checkout n'ajoute plus d'essai : la réponse n'est plus personnalisée, et l'échec vient
    // ici d'une autre dépendance de la route.
    mocks.enforceIp.mockRejectedValueOnce(new Error("Stripe secret sk_live_123 rejected"));
    const failed = await offerGet(
      new Request("https://example.test/api/billing/offer", {
        headers: { authorization: "Bearer token" },
      }),
    );
    const body = await failed.json();
    expect(failed.status).toBe(503);
    expect(body.error).toBe("Offre indisponible.");
    expect(JSON.stringify(body)).not.toContain("sk_live");
  });
});

describe("rate limit on every /api/v1 route", () => {
  const withSaleId = { params: Promise.resolve({ id: saleId }) };
  const v1Request = (path: string) =>
    new Request(`https://example.test/api/v1/${path}`, {
      headers: { authorization: "Bearer token" },
    });
  const routes: Array<[string, string, () => Promise<Response>]> = [
    [
      "v1.sale-outcome-graph",
      "sales/x/outcome-graph",
      () => v1OutcomeGraph(v1Request("sales/x/outcome-graph"), withSaleId),
    ],
    [
      "v1.sale-adjudication-statistics",
      "sales/x/adjudication-statistics",
      () => v1SaleAdjudicationStatistics(v1Request("sales/x/adjudication-statistics"), withSaleId),
    ],
    [
      "v1.sale-urbanisme-cadastre",
      "sales/x/urbanisme-cadastre",
      () => v1SaleUrbanismeCadastre(v1Request("sales/x/urbanisme-cadastre"), withSaleId),
    ],
    [
      "v1.tribunal-judicial-activity",
      "tribunals/judicial-activity",
      () => v1JudicialActivity(v1Request("tribunals/judicial-activity")),
    ],
    [
      "v1.tribunal-judicial-activity-directory",
      "tribunals/judicial-activity/directory",
      () => v1JudicialActivityDirectory(v1Request("tribunals/judicial-activity/directory")),
    ],
    [
      "v1.tribunal-statistics",
      "tribunals/statistics",
      () => v1TribunalStatistics(v1Request("tribunals/statistics")),
    ],
    [
      "v1.tribunal-listing-statistics",
      "tribunals/listing-statistics",
      () => v1ListingStatistics(v1Request("tribunals/listing-statistics")),
    ],
    [
      "v1.tribunal-auction-summaries",
      "tribunals/auction-summaries",
      () => v1AuctionSummaries(v1Request("tribunals/auction-summaries")),
    ],
    [
      "v1.tribunal-adjudication-statistics",
      "tribunals/adjudication-statistics",
      () => v1AdjudicationStatistics(v1Request("tribunals/adjudication-statistics")),
    ],
  ];

  it.each(routes)(
    "%s : 30 appels par minute et par compte, refus 429 avant tout droit d'accès",
    async (bucketKey, _path, call) => {
      mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 17));
      const response = await call();
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("17");
      // Avec le contexte de requête, qui porte le quota vers les en-têtes RateLimit-*.
      expect(mocks.enforceUser).toHaveBeenCalledWith({
        userId: "user-1",
        bucketKey,
        limit: 30,
        windowSeconds: 60,
        context: expect.objectContaining({ requestId: expect.any(String) }),
      });
      expect(mocks.entitlement).not.toHaveBeenCalled();
    },
  );

  it("aucune route /api/v1 (land-report comprise, avec son plafond propre) ne peut être ajoutée sans limite de débit par compte", () => {
    const root = fileURLToPath(new URL("./v1", import.meta.url));
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === "route.ts")
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBe(routes.length + 1);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).toContain("enforceUserRateLimit(");
    }
  });
});
