import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getSummaries: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: vi.fn(async () => 1) }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));
vi.mock("@/lib/auction-scenarios.server", () => ({
  getCourtAuctionSummaries: mocks.getSummaries,
}));

import { GET } from "@/app/api/v1/tribunals/auction-summaries/route";

const request = () => GET(new Request("https://example.test/api/v1/tribunals/auction-summaries"));

describe("GET /api/v1/tribunals/auction-summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "premium-user" });
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getSummaries.mockResolvedValue([{ courtCode: "tj-test" }]);
  });

  it("renvoie les tribunaux avec la date de génération de la réponse", async () => {
    const before = Date.now();
    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.courts).toEqual([{ courtCode: "tj-test" }]);
    expect(typeof body.generatedAt).toBe("string");
    const generatedAt = Date.parse(body.generatedAt);
    expect(generatedAt).toBeGreaterThanOrEqual(before);
    expect(generatedAt).toBeLessThanOrEqual(Date.now());
  });

  it("refuse une requête non authentifiée avant toute lecture", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing token"));
    expect((await request()).status).toBe(401);
    expect(mocks.getSummaries).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Les statistiques d’adjudication sont réservées à l’offre Analyse."),
    );
    expect((await request()).status).toBe(403);
    expect(mocks.getSummaries).not.toHaveBeenCalled();
  });

  it("répond 503 privé quand la lecture échoue", async () => {
    mocks.getSummaries.mockRejectedValue(new Error("database unavailable"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
