import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTribunalJudicialActivity,
  TribunalCourtUnresolvedError,
} from "@/lib/tribunal-judicial-activity";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertEntitlement: vi.fn(),
  getActivity: vi.fn(),
}));

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
  return { ...actual, getTribunalJudicialActivity: mocks.getActivity };
});

import { GET } from "@/app/api/v1/tribunals/judicial-activity/route";

const activity = buildTribunalJudicialActivity({
  court: {
    code: "justice_tj_1_59",
    name: "TJ Marseille",
    judicialRegion: "Aix-en-Provence",
  },
  sales: [],
  asOf: new Date("2026-08-20T12:00:00.000Z"),
  historyMonths: 36,
});

function request(query = "?courtCode=justice_tj_1_59") {
  return GET(new Request(`https://example.test/api/v1/tribunals/judicial-activity${query}`));
}

describe("GET /api/v1/tribunals/judicial-activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "premium-user" });
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.getActivity.mockResolvedValue(activity);
  });

  it("sert l’agrégat en privé au membre Analyse", async () => {
    const response = await request("?courtCode=%20Justice_TJ_1_59%20&historyMonths=36");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    await expect(response.json()).resolves.toEqual(activity);
    expect(mocks.getActivity).toHaveBeenCalledWith({
      courtCode: "justice_tj_1_59",
      historyMonths: 36,
    });
  });

  it("refuse les visiteurs avant de lire l’activité", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));
    const response = await request();

    expect(response.status).toBe(401);
    expect(mocks.getActivity).not.toHaveBeenCalled();
  });

  it("refuse le plan Découverte avant de lire l’activité", async () => {
    mocks.assertEntitlement.mockRejectedValue(
      new Error("Activité judiciaire réservée au plan Analyse."),
    );
    const response = await request();

    expect(response.status).toBe(403);
    expect(mocks.getActivity).not.toHaveBeenCalled();
  });

  it("transmet la fenêtre glissante de trois mois au dépôt", async () => {
    const response = await request("?courtCode=justice_tj_1_59&historyMonths=3");

    expect(response.status).toBe(200);
    expect(mocks.getActivity).toHaveBeenCalledWith({
      courtCode: "justice_tj_1_59",
      historyMonths: 3,
    });
  });

  it("peut résoudre le tribunal côté serveur depuis une annonce publique", async () => {
    const response = await request("?saleId=11111111-1111-4111-8111-111111111111&historyMonths=12");

    expect(response.status).toBe(200);
    expect(mocks.getActivity).toHaveBeenCalledWith({
      saleId: "11111111-1111-4111-8111-111111111111",
      historyMonths: 12,
    });
  });

  it("refuse les codes ambigus avant toute lecture de données", async () => {
    const response = await request("?courtCode=marseille%2Cparis");

    expect(response.status).toBe(400);
    expect(mocks.getActivity).not.toHaveBeenCalled();
  });

  it("exige un code tribunal", async () => {
    const response = await request("");

    expect(response.status).toBe(400);
    expect(mocks.getActivity).not.toHaveBeenCalled();
  });

  it("ne met pas durablement en cache une indisponibilité", async () => {
    mocks.getActivity.mockRejectedValue(new Error("database unavailable"));

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("distingue un rattachement non résolu d’une panne du service", async () => {
    mocks.getActivity.mockRejectedValue(new TribunalCourtUnresolvedError());
    const response = await request();
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "COURT_UNRESOLVED" });
  });
});
