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
  assertFeatureEntitlementVia: mocks.assertEntitlement,
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
    mocks.assertEntitlement.mockResolvedValue({ plan: {}, door: "plan" });
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

  it("n'envoie pas la liste des autres ventes du tribunal à un compte qui a débloqué la vente", async () => {
    const upcoming = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Maison à vendre",
      city: "Saint-Étienne",
      saleAt: "2026-09-10T08:00:00.000Z",
      startingPriceEur: 90_000,
      occupationStatus: "vacant",
      hasVisit: true,
      sourceNames: ["licitor"],
    };
    mocks.getStatistics.mockResolvedValue({
      ...statistics,
      activity: { ...statistics.activity, upcomingSales: 1, upcomingListings: [upcoming] },
    });
    const saleId = "11111111-1111-4111-8111-111111111111";

    mocks.assertEntitlement.mockResolvedValue({ plan: {}, door: "unlock" });
    const unlocked = await (await request(`?saleId=${saleId}`)).json();
    expect(unlocked.activity.upcomingListings).toEqual([]);
    // The aggregates the page shows stay.
    expect(unlocked.activity.upcomingSales).toBe(1);
    expect(unlocked.court.code).toBe("justice_tj_1_112");

    mocks.assertEntitlement.mockResolvedValue({ plan: {}, door: "plan" });
    const analysis = await (await request(`?saleId=${saleId}`)).json();
    expect(analysis.activity.upcomingListings).toEqual([upcoming]);
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

  it("réserve les statistiques d’un tribunal choisi par code à l’offre Analyse", async () => {
    await request("?courtCode=justice_tj_1_112");

    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      { userId: "premium-user" },
      "sales.statistics",
      expect.any(String),
      { saleId: undefined },
    );
  });

  it("transmet la vente à l’entitlement : un déblocage n’ouvre que le tribunal de cette vente", async () => {
    await request("?saleId=11111111-1111-4111-8111-111111111111");

    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      { userId: "premium-user" },
      "sales.statistics",
      expect.any(String),
      { saleId: "11111111-1111-4111-8111-111111111111" },
    );
  });

  it("n’ouvre jamais un tribunal par code avec une vente débloquée : requête ambiguë refusée", async () => {
    const response = await request(
      "?courtCode=justice_tj_1_112&saleId=11111111-1111-4111-8111-111111111111",
    );

    expect(response.status).toBe(400);
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it.each([
    "?saleId=11111111-1111-4111-8111-111111111111&saleId=22222222-2222-4222-8222-222222222222",
    "?saleId=22222222-2222-4222-8222-222222222222&saleId=11111111-1111-4111-8111-111111111111",
    "?courtCode=justice_tj_1_112&courtCode=justice_tj_1_113",
    "?saleId=11111111-1111-4111-8111-111111111111&historyMonths=3&historyMonths=36",
  ])("refuse un paramètre répété (%s) avant toute habilitation ou lecture", async (query) => {
    const response = await request(query);

    expect(response.status).toBe(400);
    expect(mocks.assertEntitlement).not.toHaveBeenCalled();
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("lit l’habilitation et les données sur la même valeur de saleId", async () => {
    await request("?saleId=11111111-1111-4111-8111-111111111111");

    const entitled = mocks.assertEntitlement.mock.calls[0][3];
    expect(entitled).toEqual({ saleId: "11111111-1111-4111-8111-111111111111" });
    expect(mocks.getStatistics.mock.calls[0][0].saleId).toBe(entitled.saleId);
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
