import { AdminRequiredError } from "@/lib/api-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  getAdminOfferOpeningInterviewees,
  getAdminOfferOpeningSurvey,
  parseOfferOpeningInterviewees,
  parseOfferOpeningSurvey,
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
    await expect(getAdminOfferOpeningSurvey("token")).rejects.toThrow(AdminRequiredError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("lève quand la fonction est introuvable : plus de « non mesuré » silencieux", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "absent" } });
    await expect(getAdminOfferOpeningSurvey("token")).rejects.toMatchObject({ code: "PGRST202" });
  });

  it("lève sur une autre erreur de la base", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(getAdminOfferOpeningSurvey("token")).rejects.toMatchObject({ code: "XX000" });
  });
});

describe("liste des personnes ayant accepté un entretien", () => {
  const list = {
    total: 2,
    interviewees: [
      {
        consented_at: "2026-11-07T09:00:00Z",
        profile: "marchand_de_biens",
        email: "m@example.test",
      },
      { consented_at: "2026-11-05T09:00:00Z", profile: null, email: "a@example.test" },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
    mocks.rpc.mockResolvedValue({ data: list, error: null });
  });

  it("ne garde que la date, le profil et l'email de chaque personne", () => {
    const parsed = parseOfferOpeningInterviewees({
      total: 1,
      interviewees: [{ ...list.interviewees[0], user_id: "secret", survey_price_cheap_eur: 9 }],
    });
    expect(parsed).toEqual({
      total: 1,
      interviewees: [
        {
          consentedAt: "2026-11-07T09:00:00Z",
          profile: "marchand_de_biens",
          email: "m@example.test",
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("refuse une réponse qui n'est pas celle de la fonction", () => {
    expect(() => parseOfferOpeningInterviewees({ interviewees: "non" })).toThrow();
  });

  it("lit la liste pour un administrateur et journalise la consultation sans adresse", async () => {
    const result = await getAdminOfferOpeningInterviewees("token");
    expect(mocks.rpc).toHaveBeenCalledWith("admin_offer_opening_interviewees", { p_limit: 200 });
    expect(result.interviewees).toHaveLength(2);
    const logged = String(vi.mocked(console.info).mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({
      scope: "admin.offer-opening-interviewees",
      userId: "admin-1",
      rows: 2,
    });
    expect(logged).not.toContain("@");
  });

  it("refuse un compte qui n'est pas administrateur, sans rien lire", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false });
    await expect(getAdminOfferOpeningInterviewees("token")).rejects.toThrow(AdminRequiredError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("lève quand la fonction est introuvable, au lieu d'une liste vide", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "absent" } });
    await expect(getAdminOfferOpeningInterviewees("token")).rejects.toMatchObject({
      code: "42883",
    });
  });

  it("lève sur une autre erreur de la base", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(getAdminOfferOpeningInterviewees("token")).rejects.toMatchObject({
      code: "XX000",
    });
  });
});
