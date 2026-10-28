import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforceIp: vi.fn(),
  readiness: vi.fn(),
  availability: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => request.headers.get("authorization"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/analysis-checkout-readiness", () => ({
  analysisCheckoutReadiness: mocks.readiness,
}));
vi.mock("@/lib/billing", () => ({ resolveAnalysisCheckoutAvailability: mocks.availability }));

import { GET } from "./route";

const request = (headers: HeadersInit = {}) =>
  GET(new Request("https://example.test/api/billing/offer", { headers }));

describe("GET /api/billing/offer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.enforceIp.mockResolvedValue(1);
    mocks.readiness.mockReturnValue({ open: false, missing: ["STRIPE_SECRET_KEY"] });
  });

  it("répond à un visiteur : offre non ouverte, 7 jours d'essai non proposés par la carte, cache partagé de 5 minutes", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      trialDays: 7,
      trialAvailable: false,
    });
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=60",
    );
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });

  it("ne refuse jamais un en-tête Authorization invalide : la réponse est la même, 200, sans lire le compte", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: invalid token"));

    const response = await request({ authorization: "Bearer jeton-invalide" });

    expect(response.status).toBe(200);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.availability).not.toHaveBeenCalled();
    // Une réponse identique pour tout le monde : le cache partagé reste permis.
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
  });

  it("annonce l'offre ouverte quand le paiement est configuré, sans changer l'essai (donné à l'inscription)", async () => {
    mocks.readiness.mockReturnValue({ open: true, missing: [] });

    const body = await (await request()).json();

    expect(body.configured).toBe(true);
    expect(body.trialAvailable).toBe(false);
  });

  it("limite le débit par adresse, avant toute lecture", async () => {
    await request();
    expect(mocks.enforceIp).toHaveBeenCalledWith(
      expect.objectContaining({ bucketKey: "billing.offer", limit: 60 }),
    );
  });
});
