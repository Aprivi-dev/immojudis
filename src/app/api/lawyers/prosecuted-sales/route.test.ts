import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  plan: vi.fn(),
  rateLimit: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.rateLimit }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/lawyer-prosecuted-sales.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lawyer-prosecuted-sales.server")>()),
  loadProsecutedSalesForLawyerIds: mocks.load,
}));

import { GET } from "./route";

const LAWYER_ID = "10000000-0000-4000-8000-000000000001";
const UPCOMING = {
  lawyers: {
    [LAWYER_ID]: {
      total: 1,
      sales: [
        {
          id: "0b1f7f3e-9a2c-4c55-8d5e-111111111111",
          city: "Mérignac",
          propertyType: "apartment",
          saleDate: "2026-12-01T09:00:00Z",
          startingPriceEur: 85_000,
          tribunalName: "Tribunal judiciaire de Bordeaux",
        },
      ],
    },
  },
};

function get(query = `?lawyerIds=${LAWYER_ID}`, authorized = true) {
  return GET(
    new Request(`https://example.test/api/lawyers/prosecuted-sales${query}`, {
      headers: authorized ? { authorization: "Bearer token" } : {},
    }),
  );
}

function expectNotCacheable(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("authorization");
}

describe("GET /api/lawyers/prosecuted-sales", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({ userId: "user-1" });
    mocks.rateLimit.mockResolvedValue(1);
    mocks.plan.mockResolvedValue({ plan: "analyse", hasAnalysisAccess: true });
    mocks.load.mockResolvedValue(UPCOMING);
  });

  it("rend les ventes à un compte payant durable (abonné, premium, administrateur), sans cache partagé", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expectNotCacheable(response);
    expect(await response.json()).toEqual(UPCOMING);
    expect(mocks.load).toHaveBeenCalledWith([LAWYER_ID]);
  });

  it("refuse un visiteur sans jeton (401), sans rien lire ni mettre en cache", async () => {
    const response = await get(`?lawyerIds=${LAWYER_ID}`, false);

    expect(response.status).toBe(401);
    expectNotCacheable(response);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("0b1f7f3e");
  });

  it("refuse un compte gratuit (403, sans détail), sans rien lire ni mettre en cache", async () => {
    mocks.plan.mockResolvedValue({ plan: "decouverte", hasAnalysisAccess: false });
    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(403);
    expectNotCacheable(response);
    expect(body).toMatchObject({ ok: false, code: "FORBIDDEN", error: "Accès refusé." });
    expect(JSON.stringify(body)).not.toMatch(/analyse|offre|avocat|vente/i);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("refuse un compte gratuit qui n'a les avantages Analyse que par l'offre de lancement", async () => {
    mocks.plan.mockResolvedValue({ plan: "analyse", hasAnalysisAccess: true, launchOffer: true });
    const response = await get();

    expect(response.status).toBe(403);
    expectNotCacheable(response);
    expect((await response.json()).error).toBe("Accès refusé.");
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ["absente", ""],
    ["vide", "?lawyerIds="],
    ["mal formée", "?lawyerIds=pas-un-uuid"],
    [
      "trop longue",
      `?lawyerIds=${Array.from({ length: 51 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",")}`,
    ],
  ])("refuse une liste d'avocats %s (400) sans cache partagé", async (_label, query) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expectNotCacheable(response);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("limite le débit par compte, sans cache partagé", async () => {
    mocks.rateLimit.mockRejectedValue(new RateLimitError(undefined, 12));
    const response = await get();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expectNotCacheable(response);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("répond une erreur générique, sans cache partagé, quand la lecture échoue", async () => {
    mocks.load.mockRejectedValue(new Error("connection to supabase.co refused"));
    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(503);
    expectNotCacheable(response);
    expect(JSON.stringify(body)).not.toContain("supabase");
  });
});
