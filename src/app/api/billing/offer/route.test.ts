import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforceIp: vi.fn(),
  readiness: vi.fn(),
  availability: vi.fn(),
  deduction: vi.fn(),
  saleUnlockReadiness: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => request.headers.get("authorization"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.enforceIp }));
vi.mock("@/lib/analysis-checkout-readiness", () => ({
  analysisCheckoutReadiness: mocks.readiness,
}));
vi.mock("@/lib/billing", () => ({
  resolveAnalysisCheckoutAvailability: mocks.availability,
}));
vi.mock("@/lib/billing-unit-deduction", () => ({
  previewFirstMonthDeductionCents: mocks.deduction,
}));
vi.mock("@/lib/sale-unlock-checkout-readiness", () => ({
  saleUnlockCheckoutReadiness: mocks.saleUnlockReadiness,
}));

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
    mocks.saleUnlockReadiness.mockReturnValue({ open: false });
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
    mocks.requireAuth.mockRejectedValue(new AuthRequiredError("Unauthorized: invalid token"));

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

  it("annonce l'achat à l'unité (fermé par défaut, 19 €) et aucune déduction à un visiteur", async () => {
    const response = await request();

    expect(await response.json()).toMatchObject({
      saleUnlock: { open: false, label: "19 €", amountCents: 1_900 },
      firstMonthDeductionCents: 0,
    });
    expect(mocks.deduction).not.toHaveBeenCalled();
  });

  it("dit l'achat à l'unité ouvert selon sa propre garde, même souscription Analyse fermée", async () => {
    mocks.saleUnlockReadiness.mockReturnValue({ open: true });

    const body = await (await request()).json();

    expect(body.configured).toBe(false);
    expect(body.saleUnlock.open).toBe(true);
  });

  it("donne au compte connecté la déduction de son premier mois, en réponse privée", async () => {
    mocks.readiness.mockReturnValue({ open: true, missing: [] });
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.deduction.mockResolvedValue(3_800);

    const response = await request({ authorization: "Bearer jeton" });

    expect(response.status).toBe(200);
    expect((await response.json()).firstMonthDeductionCents).toBe(3_800);
    expect(mocks.deduction).toHaveBeenCalledWith({ userId: "user-1" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("répond l'offre anonyme, en cache partagé, à un jeton qui n'authentifie pas", async () => {
    mocks.readiness.mockReturnValue({ open: true, missing: [] });
    mocks.requireAuth.mockRejectedValue(new AuthRequiredError("Unauthorized: invalid token"));

    const response = await request({ authorization: "Bearer jeton-invalide" });

    expect(response.status).toBe(200);
    expect((await response.json()).firstMonthDeductionCents).toBe(0);
    expect(mocks.deduction).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
  });

  it("affiche 0 plutôt que de rendre l'offre indisponible quand l'aperçu échoue", async () => {
    mocks.readiness.mockReturnValue({ open: true, missing: [] });
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.deduction.mockRejectedValue(new Error("relation does not exist"));

    const response = await request({ authorization: "Bearer jeton" });

    expect(response.status).toBe(200);
    expect((await response.json()).firstMonthDeductionCents).toBe(0);
  });
});
