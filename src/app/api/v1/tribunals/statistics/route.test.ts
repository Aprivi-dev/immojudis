import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TribunalStatisticsResponse } from "@/lib/tribunal-statistics";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getStatistics: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));

vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));

vi.mock("@/lib/tribunal-statistics-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tribunal-statistics-repository")>();
  return { ...actual, getTribunalStatistics: mocks.getStatistics };
});

vi.mock("@/lib/usage", () => ({
  recordFeatureUsageEvent: mocks.recordUsage,
}));

import { GET } from "@/app/api/v1/tribunals/statistics/route";

const auth = { userId: "premium-user" };
const statistics = {
  national: { reliability: { level: "robust" } },
  tribunals: [{ tribunal: { code: "bordeaux" } }],
  meta: {
    generatedAt: "2026-07-01T01:00:00.000Z",
    experimental: true,
    windowMonths: 36,
    roundKind: "initial",
    warnings: [],
  },
} as unknown as TribunalStatisticsResponse;

function request(query = "") {
  return GET(
    new Request(`https://example.test/api/v1/tribunals/statistics${query}`, {
      headers: { authorization: "Bearer valid-token" },
    }),
  );
}

describe("GET /api/v1/tribunals/statistics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getStatistics.mockResolvedValue(statistics);
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it("refuse une requête non authentifiée avant entitlement et lecture", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: invalid token"));

    const response = await request();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(mocks.assertEntitlement).not.toHaveBeenCalled();
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte avant toute lecture de snapshot", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Statistiques par tribunal réservées au plan Analyse."),
    );

    const response = await request();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      auth,
      "sales.statistics",
      expect.stringContaining("Analyse"),
    );
    expect(mocks.getStatistics).not.toHaveBeenCalled();
  });

  it("valide les paramètres seulement après authentification et entitlement", async () => {
    const response = await request("?windowMonths=18&courtCode=bordeaux%2Cparis");

    expect(response.status).toBe(400);
    expect(mocks.assertEntitlement).toHaveBeenCalledOnce();
    expect(mocks.getStatistics).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("renvoie 503 lorsque le kill switch ou les snapshots rendent le service indisponible", async () => {
    mocks.getStatistics.mockRejectedValue(
      new Error("Configuration: tribunal statistics are disabled."),
    );

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "CONFIGURATION_ERROR",
      error: "Service temporairement indisponible.",
    });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("sert une réponse privée, normalise le filtre et journalise sans identifiant interne", async () => {
    const response = await request("?windowMonths=12&courtCode=%20Bordeaux%20");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    await expect(response.json()).resolves.toEqual(statistics);
    expect(mocks.getStatistics).toHaveBeenCalledWith({
      windowMonths: 12,
      courtCode: "bordeaux",
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      auth,
      eventKey: "tribunal.statistics_viewed",
      subjectType: "tribunal_statistics",
      metadata: {
        window_months: 12,
        court_code: "bordeaux",
        tribunal_count: 1,
        national_reliability: "robust",
        experimental: true,
      },
    });
    const usagePayload = mocks.recordUsage.mock.calls[0]?.[0];
    expect(usagePayload).not.toHaveProperty("subjectId");
    expect(JSON.stringify(usagePayload)).not.toMatch(/snapshot|member|outcome|decision/i);

    expect(mocks.requireAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertEntitlement.mock.invocationCallOrder[0],
    );
    expect(mocks.assertEntitlement.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getStatistics.mock.invocationCallOrder[0],
    );
  });

  it("utilise 36 mois par défaut", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(mocks.getStatistics).toHaveBeenCalledWith({ windowMonths: 36 });
  });

  it("reste disponible lorsque la télémétrie non critique échoue", async () => {
    mocks.recordUsage.mockRejectedValue(new Error("usage store unavailable"));

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(statistics);
  });

  it("n’attend pas une télémétrie qui ne répond jamais", async () => {
    let resolveTelemetry: (() => void) | undefined;
    const telemetry = new Promise<void>((resolve) => {
      resolveTelemetry = resolve;
    });
    mocks.recordUsage.mockReturnValue(telemetry);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const winner = await Promise.race([
      request(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    resolveTelemetry?.();

    expect(winner).not.toBe("timeout");
    expect((winner as Response).status).toBe(200);
  });

  it("reste disponible si l’adaptateur de télémétrie lève synchroniquement", async () => {
    mocks.recordUsage.mockImplementation(() => {
      throw new Error("synchronous telemetry adapter failure");
    });

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(statistics);
  });
});
