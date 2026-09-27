import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredCadastralParcel } from "@/lib/cadastre-analysis";
import type { StructuredUrbanPlanningSignal } from "@/lib/urban-planning-analysis";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getSale: vi.fn(),
  getCadastralParcels: vi.fn(),
  getUrbanPlanningSignals: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));

vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));

vi.mock("@/lib/property-report/repository", () => ({
  getSale: mocks.getSale,
  getCadastralParcels: mocks.getCadastralParcels,
  getUrbanPlanningSignals: mocks.getUrbanPlanningSignals,
}));

import { GET } from "@/app/api/v1/sales/[id]/urbanisme-cadastre/route";

const saleId = "11111111-1111-4111-8111-111111111111";
const auth = { userId: "premium-user", supabase: { client: "auth-scoped" } };
const sale = { source_url: "https://example.test/vente/1" };
const cadastralParcels: StructuredCadastralParcel[] = [
  {
    parcelKey: "33000-AB-12",
    parcelId: "33000AB0012",
    codeInsee: "33063",
    department: "33",
    city: "Bordeaux",
    section: "AB",
    parcelNumber: "12",
    surfaceM2: 420,
    centroidLat: 44.84,
    centroidLng: -0.58,
    matchKind: "reference_lookup",
    confidence: 0.98,
    sourceApi: "cadastre.data.gouv.fr",
  },
];
const urbanPlanningSignals: StructuredUrbanPlanningSignal[] = [
  {
    signalKey: "plu-zonage",
    signalKind: "zoning",
    label: "Zone urbaine",
    status: "documented",
    priority: "medium",
    sourceName: "PLU",
    sourceKind: "document",
    documentUrl: "https://example.test/plu.pdf",
    documentLabel: "Règlement PLU",
    documentType: "plu",
    pageNumber: 12,
    excerpt: "Zone UB",
    action: "Vérifier le règlement.",
    confidence: 0.9,
    updatedAt: "2026-09-27T10:00:00.000Z",
  },
];

function request(id = saleId) {
  return GET(new Request(`https://example.test/api/v1/sales/${id}/urbanisme-cadastre`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/v1/sales/:id/urbanisme-cadastre", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getSale.mockResolvedValue(sale);
    mocks.getCadastralParcels.mockResolvedValue(cadastralParcels);
    mocks.getUrbanPlanningSignals.mockResolvedValue(urbanPlanningSignals);
  });

  it("refuse une requête non authentifiée avant toute lecture", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await request();

    expect(response.status).toBe(401);
    expect(mocks.assertEntitlement).not.toHaveBeenCalled();
    expect(mocks.getSale).not.toHaveBeenCalled();
    expect(mocks.getCadastralParcels).not.toHaveBeenCalled();
    expect(mocks.getUrbanPlanningSignals).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte avant la résolution de la vente", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Les données cadastrales sont réservées au plan Analyse."),
    );

    const response = await request();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      auth,
      "property.cadastralAnalysis",
      expect.stringContaining("Analyse"),
    );
    expect(mocks.getSale).not.toHaveBeenCalled();
  });

  it("valide l’identifiant après authentification et entitlements", async () => {
    const response = await request("not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.assertEntitlement).toHaveBeenCalledTimes(2);
    expect(mocks.getSale).not.toHaveBeenCalled();
  });

  it("résout la vente avec le client authentifié puis filtre les deux sources par source_url", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    await expect(response.json()).resolves.toEqual({ cadastralParcels, urbanPlanningSignals });
    expect(mocks.getSale).toHaveBeenCalledWith(auth.supabase, saleId);
    expect(mocks.getCadastralParcels).toHaveBeenCalledWith(sale.source_url);
    expect(mocks.getUrbanPlanningSignals).toHaveBeenCalledWith(sale.source_url);
    expect(mocks.assertEntitlement).toHaveBeenNthCalledWith(
      1,
      auth,
      "property.cadastralAnalysis",
      expect.stringContaining("Analyse"),
    );
    expect(mocks.assertEntitlement).toHaveBeenNthCalledWith(
      2,
      auth,
      "property.urbanPlanning",
      expect.stringContaining("Analyse"),
    );
  });

  it("ne lit pas les enrichissements si la vente n’est pas accessible", async () => {
    mocks.getSale.mockRejectedValue(new Error("Vente introuvable ou inaccessible."));

    const response = await request();

    expect(response.status).toBe(503);
    expect(mocks.getCadastralParcels).not.toHaveBeenCalled();
    expect(mocks.getUrbanPlanningSignals).not.toHaveBeenCalled();
  });
});
