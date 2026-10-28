import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  getAdminOfferOpeningSurvey,
  parseOfferOpeningSurvey,
  unavailableOfferOpeningSurvey,
} from "./admin-offer-opening-survey";

const raw = {
  generated_at: "2026-11-10T12:00:00Z",
  min_median_answers: 10,
  answered: 14,
  profiles: { particulier: 8, marchand_de_biens: 3, avocat: 1, autre: 0, unanswered: 2 },
  price_too_expensive: { answers: 12, median_eur: 120 },
  price_cheap: { answers: 6, median_eur: null },
  interview_accepted: 4,
};

describe("parseOfferOpeningSurvey", () => {
  it("lit les profils, les deux repères de prix et les acceptants d'un entretien", () => {
    expect(parseOfferOpeningSurvey(raw)).toEqual({
      generatedAt: "2026-11-10T12:00:00Z",
      answered: 14,
      profiles: { particulier: 8, marchand_de_biens: 3, avocat: 1, autre: 0, unanswered: 2 },
      priceTooExpensive: { answers: 12, medianEur: 120 },
      priceCheap: { answers: 6, medianEur: null },
      interviewAccepted: 4,
      minMedianAnswers: 10,
    });
  });

  it("garde zéro comme zéro et traite le reste comme « non mesuré »", () => {
    const parsed = parseOfferOpeningSurvey({ answered: 0 });
    expect(parsed.answered).toBe(0);
    expect(parsed.profiles.particulier).toBeNull();
    expect(parsed.priceCheap).toEqual({ answers: null, medianEur: null });
  });

  it("ne garde aucune clé inconnue (aucune ligne individuelle)", () => {
    const parsed = parseOfferOpeningSurvey({ ...raw, user_id: "secret", email: "a@b.test" });
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("a@b.test");
  });

  it("refuse une réponse qui n'est pas celle de la fonction", () => {
    expect(() => parseOfferOpeningSurvey({ profiles: "non" })).toThrow();
  });
});

describe("getAdminOfferOpeningSurvey", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: raw, error: null });
  });

  it("lit l'agrégat pour un administrateur", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const summary = await getAdminOfferOpeningSurvey("token", now);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_offer_opening_survey_summary", {
      p_now: now.toISOString(),
    });
    expect(summary.answered).toBe(14);
  });

  it("refuse un compte qui n'est pas administrateur, sans rien lire", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false });
    await expect(getAdminOfferOpeningSurvey("token")).rejects.toThrow(/Forbidden/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rend « non mesuré » quand la fonction n'existe pas encore", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "absent" } });
    expect(await getAdminOfferOpeningSurvey("token")).toEqual(unavailableOfferOpeningSurvey());
  });

  it("lève sur une autre erreur de la base", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(getAdminOfferOpeningSurvey("token")).rejects.toMatchObject({ code: "XX000" });
  });
});
