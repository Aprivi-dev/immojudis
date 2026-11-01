import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), evaluate: vi.fn(), list: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/alert-matches", () => ({
  evaluateUserAlertMatches: mocks.evaluate,
  listUserAlertMatches: mocks.list,
}));

import { POST } from "./route";

const RAW_ERROR =
  'canceling statement due to statement timeout · Key (user_id)=(abc) is not present · Hint: check "user_alerts" (57014)';

function evaluation(overrides: Record<string, unknown> = {}) {
  return {
    evaluatedAt: "2026-10-23T10:00:00.000Z",
    alertCount: 2,
    saleCount: 10,
    matchCount: 0,
    notificationCount: 0,
    persisted: true,
    failedAlertCount: 0,
    alertFailures: [],
    matches: [],
    ...overrides,
  };
}

const call = () =>
  POST(
    new Request("https://example.test/api/alerts/matches", {
      method: "POST",
      body: JSON.stringify({ persist: true }),
    }),
  );

describe("POST /api/alerts/matches", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({ userId: "user-1" });
  });

  it("répond 200 quand toutes les alertes sont évaluées", async () => {
    mocks.evaluate.mockResolvedValue(evaluation({ matchCount: 3 }));
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ matchCount: 3, failedAlertCount: 0 });
  });

  it("répond 200 sans alerte à évaluer (0 alerte n'est pas un échec)", async () => {
    mocks.evaluate.mockResolvedValue(evaluation({ alertCount: 0 }));
    expect((await call()).status).toBe(200);
  });

  describe("corps de la requête", () => {
    const withBody = (body?: string) =>
      POST(new Request("https://example.test/api/alerts/matches", { method: "POST", body }));

    it("répond 400 pour un corps JSON null, mal formé ou de mauvais type, sans rien évaluer", async () => {
      for (const body of [
        "null",
        "{pas du json",
        "[]",
        '"texte"',
        '{"persist":"oui"}',
        '{"saleLimit":-3}',
      ]) {
        const response = await withBody(body);
        expect(response.status, body).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
      }
      expect(mocks.evaluate).not.toHaveBeenCalled();
    });

    it("garde les valeurs par défaut quand le corps est absent ou vide", async () => {
      mocks.evaluate.mockResolvedValue(evaluation());
      expect((await withBody()).status).toBe(200);
      expect((await withBody("   ")).status).toBe(200);
      expect((await withBody("{}")).status).toBe(200);
      expect(mocks.evaluate).toHaveBeenCalledTimes(3);
      expect(mocks.evaluate).toHaveBeenLastCalledWith(
        expect.objectContaining({ saleLimit: undefined, persist: true }),
      );
    });

    it("transmet saleLimit et persist valides", async () => {
      mocks.evaluate.mockResolvedValue(evaluation());
      await withBody(JSON.stringify({ saleLimit: 500, persist: false }));
      expect(mocks.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ saleLimit: 500, persist: false }),
      );
    });
  });

  it("répond 503 quand toutes les alertes échouent, sans le message brut", async () => {
    mocks.evaluate.mockResolvedValue(
      evaluation({
        failedAlertCount: 2,
        alertFailures: [
          { alertId: "a1", error: RAW_ERROR },
          { alertId: "a2", error: RAW_ERROR },
        ],
      }),
    );
    const response = await call();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("statement timeout");
    expect(text).not.toContain("user_alerts");
    expect(JSON.parse(text)).toMatchObject({ ok: false });
  });

  it("garde un 200 quand une partie seulement des alertes échoue, avec un code et sans message brut", async () => {
    mocks.evaluate.mockResolvedValue(
      evaluation({
        matchCount: 1,
        failedAlertCount: 1,
        alertFailures: [{ alertId: "a2", error: RAW_ERROR }],
      }),
    );
    const response = await call();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("statement timeout");
    expect(text).not.toContain("user_alerts");
    const body = JSON.parse(text);
    expect(body.failedAlertCount).toBe(1);
    expect(body.alertFailures).toEqual([{ alertId: "a2", code: "alert_evaluation_failed" }]);
  });
});
