import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  entitlement: vi.fn(),
  sale: vi.fn(),
  parcels: vi.fn(),
  rate: vi.fn(),
  location: vi.fn(),
  report: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "bearer",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: mocks.entitlement }));
vi.mock("@/lib/property-report/repository", () => ({
  getSale: mocks.sale,
  getCadastralParcels: mocks.parcels,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.rate }));
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
  version: "land-report-v1",
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
    mocks.entitlement.mockResolvedValue(undefined);
    mocks.sale.mockResolvedValue(sale);
    mocks.parcels.mockResolvedValue([]);
    mocks.rate.mockResolvedValue(undefined);
    mocks.location.mockReturnValue({ address: sale.address });
    mocks.report.mockResolvedValue(report);
  });
  it("refuse un visiteur avant toute consultation des sources", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));
    expect((await request()).status).toBe(401);
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("refuse un compte sans abonnement Analyse", async () => {
    mocks.entitlement.mockRejectedValue(
      new Error("Cette fonctionnalité est réservée au plan Analyse."),
    );
    expect((await request()).status).toBe(403);
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("ne consulte aucune source pour une vente inaccessible", async () => {
    mocks.sale.mockRejectedValue(new Error("Vente introuvable ou inaccessible."));
    expect((await request()).status).toBe(503);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("valide identifiant et format sans accepter une URL de fournisseur arbitraire", async () => {
    expect((await request("", "bad-id")).status).toBe(400);
    expect((await request("?format=html")).status).toBe(400);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("applique le quota avant l'appel aux sources officielles", async () => {
    mocks.rate.mockRejectedValue(new Error("Trop de demandes. Réessayez dans quelques instants."));
    expect((await request()).status).toBe(429);
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("renvoie le dossier privé avec contrôle de vente authentifié et actualisation explicite", async () => {
    const response = await request("?refresh=1&url=https://example.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toEqual({ report });
    expect(mocks.sale).toHaveBeenCalledWith(context.supabase, id);
    expect(mocks.report).toHaveBeenCalledWith({ address: sale.address }, { refresh: true });
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
    );
  });
});
