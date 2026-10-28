import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-directory";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getDirectory: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: vi.fn(async () => 1) }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/property-reports", () => ({
  assertFeatureEntitlement: mocks.assertEntitlement,
}));

vi.mock("@/lib/tribunal-judicial-activity-repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tribunal-judicial-activity-repository")>();
  return { ...actual, getTribunalJudicialActivityDirectory: mocks.getDirectory };
});

import { GET } from "@/app/api/v1/tribunals/judicial-activity/directory/route";

const directory = buildTribunalJudicialActivityDirectory({
  courts: [],
  sales: [],
  asOf: new Date("2026-08-20T12:00:00.000Z"),
  historyMonths: 36,
});

function request(query = "?historyMonths=36") {
  return GET(
    new Request(`https://example.test/api/v1/tribunals/judicial-activity/directory${query}`),
  );
}

describe("GET /api/v1/tribunals/judicial-activity/directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "premium-user" });
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getDirectory.mockResolvedValue(directory);
  });

  it("sert l’annuaire agrégé en privé au membre Analyse", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    await expect(response.json()).resolves.toEqual(directory);
    expect(mocks.getDirectory).toHaveBeenCalledWith({ historyMonths: 36 });
  });

  it("refuse les visiteurs avant de lire l’annuaire", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));
    const response = await request();

    expect(response.status).toBe(401);
    expect(mocks.getDirectory).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte avant de lire l’annuaire", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Répertoire des tribunaux réservé à l’offre Analyse."),
    );
    const response = await request();

    expect(response.status).toBe(403);
    expect(mocks.getDirectory).not.toHaveBeenCalled();
  });

  it("refuse les paramètres inattendus avant toute lecture", async () => {
    const response = await request("?historyMonths=36&courtCode=paris");

    expect(response.status).toBe(400);
    expect(mocks.getDirectory).not.toHaveBeenCalled();
  });

  it("ne met pas durablement en cache une indisponibilité", async () => {
    mocks.getDirectory.mockRejectedValue(new Error("database unavailable"));

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("répond 503 (et non 400) quand la réponse construite ne respecte pas son propre schéma", async () => {
    // Un défaut côté serveur (ici un effectif incohérent) n'est pas une faute du client.
    mocks.getDirectory.mockResolvedValue({ ...directory, schemaVersion: "autre" });
    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(console.error).toHaveBeenCalled();
  });
});
