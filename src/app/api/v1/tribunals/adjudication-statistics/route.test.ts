import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getDirectory: vi.fn(),
  recordUsage: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/property-reports", () => ({ assertFeatureEntitlement: mocks.assertEntitlement }));
vi.mock("@/lib/adjudication-price-statistics-repository", () => ({
  getAdjudicationPriceStatisticsDirectory: mocks.getDirectory,
}));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: mocks.recordUsage }));

import { GET } from "./route";

const auth = { userId: "premium-user" };
const directory = {
  national: { sampleSize: 3798 },
  tribunals: [{ courtCode: "bordeaux", sampleSize: 146 }],
};
const request = () =>
  GET(new Request("https://example.test/api/v1/tribunals/adjudication-statistics"));

describe("GET /api/v1/tribunals/adjudication-statistics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getDirectory.mockResolvedValue(directory);
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it("refuse les visiteurs avant de lire les prix", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));
    const response = await request();
    expect(response.status).toBe(401);
    expect(mocks.getDirectory).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte avant de lire les prix", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Statistiques d’adjudication réservées au plan Analyse."),
    );
    const response = await request();
    expect(response.status).toBe(403);
    expect(mocks.getDirectory).not.toHaveBeenCalled();
  });

  it("renvoie uniquement la réponse privée au membre Analyse", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    await expect(response.json()).resolves.toEqual(directory);
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ national_sample_size: 3798, tribunal_count: 1 }),
      }),
    );
  });
});
