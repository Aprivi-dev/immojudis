import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTribunalListingStatistics,
  TribunalCourtUnresolvedError,
} from "@/lib/tribunal-listing-statistics";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getStatistics: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));

vi.mock("@/lib/tribunal-listing-statistics-repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tribunal-listing-statistics-repository")>();
  return { ...actual, getTribunalListingStatistics: mocks.getStatistics };
});

import { GET } from "@/app/api/v1/tribunals/listing-statistics/route";

const statistics = buildTribunalListingStatistics({
  court: {
    code: "justice_tj_1_112",
    name: "TJ Saint-Etienne",
    judicialRegion: "Lyon",
  },
  sales: [],
  asOf: new Date("2026-08-20T12:00:00.000Z"),
  historyMonths: 3,
});

function request(query = "?courtCode=justice_tj_1_112") {
  return GET(new Request(`https://example.test/api/v1/tribunals/listing-statistics${query}`));
}

describe("GET /api/v1/tribunals/listing-statistics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "premium-user" });
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getStatistics.mockResolvedValue(statistics);
  });

  it("sert une réponse privée au membre Analyse avec la fenêtre récente par défaut", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    await expect(response.json()).resolves.toEqual(statistics);
    expect(mocks.getStatistics).toHaveBeenCalledWith({
      courtCode: "justice_tj_1_112",
      historyMonths: 3,
    });
  });

  it("refuse les visiteurs avant de lire les statistiques", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));
    const response = await request();

    expect(response.status).toBe(401);
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte avant de lire les statistiques", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Statistiques des annonces judiciaires réservées au plan Analyse."),
    );
    const response = await request();

    expect(response.status).toBe(403);
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("préserve les fenêtres historiques et la résolution par annonce", async () => {
    const response = await request("?saleId=11111111-1111-4111-8111-111111111111&historyMonths=36");

    expect(response.status).toBe(200);
    expect(mocks.getStatistics).toHaveBeenCalledWith({
      saleId: "11111111-1111-4111-8111-111111111111",
      historyMonths: 36,
    });
  });

  it("refuse une requête ambiguë avant le dépôt", async () => {
    const response = await request(
      "?courtCode=justice_tj_1_112&saleId=11111111-1111-4111-8111-111111111111",
    );

    expect(response.status).toBe(400);
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("retourne 422 lorsque le tribunal ne peut pas être résolu", async () => {
    mocks.getStatistics.mockRejectedValue(new TribunalCourtUnresolvedError());
    const response = await request();

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "COURT_UNRESOLVED" });
  });
});
