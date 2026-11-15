import { SalePublicationUnavailableError } from "@/lib/sale-publication-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError, RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  entitlement: vi.fn(),
  sale: vi.fn(),
  parcels: vi.fn(),
  rate: vi.fn(),
  daily: vi.fn(),
  location: vi.fn(),
  report: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "bearer",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/entitlements.server", () => ({
  assertFeatureEntitlementVia: mocks.entitlement,
  getSaleForDoor: mocks.sale,
}));
vi.mock("@/lib/property-report/repository", () => ({ getCadastralParcels: mocks.parcels }));
vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: mocks.rate,
  enforceDailyOperationLimits: mocks.daily,
}));
vi.mock("@/lib/land-report-input", () => ({ landLocationInputFromSale: mocks.location }));
vi.mock("@/lib/land-report", () => ({ getCachedLandReport: mocks.report }));
import { GET } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const context = { userId: "premium", supabase: {} };
const sale = {
  address: "17 rue Roland Garros",
  postal_code: "02100",
  city: "Saint-Quentin",
  source_url: "https://www.licitor.com/annonce/109477.html",
};
const report = {
  version: "land-report-v1.1",
  generatedAt: "2026-10-02T12:00:00Z",
  planning: {
    locationStatus: "unresolved",
    parcels: [],
    zones: [],
    documents: [],
    constraints: [],
    checks: [],
    warnings: [],
    completeCoverage: false,
  },
  risks: { findings: [], checks: [], warnings: [] },
  rules: { rules: [], checks: [], warnings: [], completeCoverage: false },
  projects: [],
};
const ANALYSIS = { plan: { plan: "analyse" }, door: "plan" };
const UNLOCK = { plan: { plan: "decouverte" }, door: "unlock" };
function request(query = "", saleId = id) {
  return GET(new Request(`https://immojudis.com/api/v1/sales/${saleId}/land-report${query}`), {
    params: Promise.resolve({ id: saleId }),
  });
}

describe("dossier PLU et risques premium", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue(context);
    mocks.entitlement.mockResolvedValue(ANALYSIS);
    mocks.sale.mockResolvedValue({ sale, enrichmentKey: sale.source_url });
    mocks.parcels.mockResolvedValue([]);
    mocks.rate.mockResolvedValue(undefined);
    mocks.daily.mockResolvedValue(undefined);
    mocks.location.mockReturnValue({ address: sale.address });
    mocks.report.mockResolvedValue(report);
  });
  it("refuse un visiteur avant toute consultation des sources", async () => {
    mocks.auth.mockRejectedValue(new AuthRequiredError("Unauthorized: missing bearer token"));
    expect((await request()).status).toBe(401);
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("refuse un compte sans abonnement Analyse", async () => {
    mocks.entitlement.mockRejectedValue(
      new ForbiddenError("Cette fonctionnalité est réservée à l’offre Analyse."),
    );
    expect((await request()).status).toBe(403);
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("ne consulte aucune source pour une vente inaccessible", async () => {
    mocks.sale.mockRejectedValue(new SalePublicationUnavailableError());
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("valide identifiant et format sans accepter une URL de fournisseur arbitraire", async () => {
    expect((await request("", "bad-id")).status).toBe(400);
    expect((await request("?format=html")).status).toBe(400);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("applique le quota avant l'appel aux sources officielles", async () => {
    mocks.rate.mockRejectedValue(new RateLimitError());
    expect((await request()).status).toBe(429);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("applique le plafond journalier (compte, adresse, site) avant les sources, avec le message quotidien", async () => {
    const { RateLimitError } = await import("@/lib/api-errors");
    mocks.daily.mockRejectedValue(
      new RateLimitError(undefined, 7200, "Limite quotidienne atteinte, réessayez demain."),
    );
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7200");
    expect(await response.json()).toMatchObject({
      error: "Limite quotidienne atteinte, réessayez demain.",
    });
    expect(mocks.daily).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "premium", operation: "landReport" }),
    );
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("renvoie le dossier privé avec contrôle de vente authentifié et actualisation explicite", async () => {
    const response = await request("?refresh=1&url=https://example.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toEqual({ report });
    expect(mocks.sale).toHaveBeenCalledWith(context, id, "plan");
    expect(mocks.parcels).toHaveBeenCalledWith(sale.source_url);
    expect(mocks.report).toHaveBeenCalledWith({ address: sale.address }, { refresh: true });
  });
  it("contrôle les droits en parallèle, avant toute lecture de la vente", async () => {
    const releases: Array<(value: unknown) => void> = [];
    mocks.entitlement.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const pending = request("?format=pdf");
    await vi.waitFor(() => expect(mocks.entitlement).toHaveBeenCalledTimes(3));
    expect(mocks.sale).not.toHaveBeenCalled();
    for (const release of releases) release(ANALYSIS);
    expect((await pending).status).toBe(200);
  });
  it("exporte un vrai PDF après vérification du droit d'export", async () => {
    const response = await request("?format=pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(id);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toMatch(/^%PDF-1\.4/);
    expect(mocks.entitlement).toHaveBeenCalledWith(
      context,
      "property.pdfExport",
      expect.any(String),
      { saleId: id },
    );
  });

  describe("vente débloquée par un compte Découverte", () => {
    // Ce que `getSaleForDoor` rend pour la porte du déblocage : la vente sans ses sources.
    const unlockedSale = { ...sale, source_url: null };

    beforeEach(() => {
      mocks.entitlement.mockResolvedValue(UNLOCK);
      mocks.sale.mockResolvedValue({ sale: unlockedSale, enrichmentKey: sale.source_url });
    });

    it("passe la vente à chaque droit, pour que son déblocage les ouvre", async () => {
      expect((await request("?format=pdf")).status).toBe(200);
      for (const feature of [
        "property.urbanPlanning",
        "property.cadastralAnalysis",
        "property.pdfExport",
      ]) {
        expect(mocks.entitlement).toHaveBeenCalledWith(context, feature, expect.any(String), {
          saleId: id,
        });
      }
    });

    it("sert le dossier en cache, lu par la porte du déblocage, sans renvoyer la source", async () => {
      const response = await request();
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("licitor");
      expect(mocks.sale).toHaveBeenCalledWith(context, id, "unlock");
      // Le cadastre est retrouvé par la clé lue côté serveur.
      expect(mocks.parcels).toHaveBeenCalledWith(sale.source_url);
      expect(mocks.report).toHaveBeenCalledWith({ address: sale.address }, { refresh: false });
    });

    it("refuse l'actualisation (refresh=1) avant toute lecture et tout appel aux sources", async () => {
      const response = await request("?refresh=1");
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "FORBIDDEN",
        error: expect.stringContaining("actualisation"),
      });
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(mocks.daily).not.toHaveBeenCalled();
      expect(mocks.report).not.toHaveBeenCalled();
    });

    it("refuse une autre vente que la vente débloquée", async () => {
      mocks.entitlement.mockRejectedValue(
        new ForbiddenError("L’analyse du PLU et des risques est réservée à l’offre Analyse."),
      );
      expect((await request()).status).toBe(403);
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(mocks.report).not.toHaveBeenCalled();
    });
  });
});
