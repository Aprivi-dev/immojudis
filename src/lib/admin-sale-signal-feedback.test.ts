import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  getAdminSaleFeedbackBySale,
  getAdminSaleSignalFeedback,
  parseSaleFeedbackBySale,
  parseSaleSignalFeedbackSummary,
  unavailableSaleFeedbackBySale,
  unavailableSaleSignalFeedback,
} from "./admin-sale-signal-feedback";

const raw = {
  generated_at: "2026-11-10T12:00:00Z",
  window_days: 90,
  signals: [
    {
      signal: "market_gap_band",
      total: 12,
      useful: 9,
      not_relevant: 3,
      accounts: 7,
      reasons: { estimate_too_high: 2, estimate_too_low: 1 },
    },
    {
      signal: "points_to_verify",
      total: 8,
      useful: 4,
      not_relevant: 4,
      accounts: 5,
      reasons: { point_wrong: 3, point_missing: 1 },
    },
    {
      signal: "pepite",
      total: 6,
      useful: 2,
      not_relevant: 4,
      accounts: 4,
      reasons: { amount_too_high: 2, criterion_wrong: 1, not_interesting: 1 },
      rule_versions: { "pepite-v1": 5, "pepite-v2": 1 },
    },
  ],
};

describe("parseSaleSignalFeedbackSummary", () => {
  it("lit les trois signaux, leurs parts et leurs motifs", () => {
    expect(parseSaleSignalFeedbackSummary(raw)).toEqual({
      generatedAt: "2026-11-10T12:00:00Z",
      windowDays: 90,
      signals: {
        market_gap_band: {
          total: 12,
          useful: 9,
          notRelevant: 3,
          accounts: 7,
          reasons: { estimate_too_high: 2, estimate_too_low: 1 },
          ruleVersions: {},
        },
        points_to_verify: {
          total: 8,
          useful: 4,
          notRelevant: 4,
          accounts: 5,
          reasons: { point_wrong: 3, point_missing: 1 },
          ruleVersions: {},
        },
        pepite: {
          total: 6,
          useful: 2,
          notRelevant: 4,
          accounts: 4,
          reasons: { amount_too_high: 2, criterion_wrong: 1, not_interesting: 1 },
          ruleVersions: { "pepite-v1": 5, "pepite-v2": 1 },
        },
      },
    });
  });

  it("garde zéro comme zéro et traite le reste comme « non mesuré »", () => {
    const parsed = parseSaleSignalFeedbackSummary({
      signals: [{ signal: "market_gap_band", total: 0, useful: 0, not_relevant: 0, accounts: 0 }],
    });

    expect(parsed.signals.market_gap_band.total).toBe(0);
    expect(parsed.signals.market_gap_band.reasons).toEqual({
      estimate_too_high: null,
      estimate_too_low: null,
    });
    expect(parsed.signals.points_to_verify).toEqual(
      unavailableSaleSignalFeedback().signals.points_to_verify,
    );
  });

  it("ne garde aucune clé inconnue de la réponse", () => {
    const parsed = parseSaleSignalFeedbackSummary({
      ...raw,
      signals: [{ ...raw.signals[0], user_id: "secret", reasons: { free_text: 3 } }],
    });

    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("free_text");
  });

  it("refuse une réponse qui n'est pas celle de la fonction", () => {
    expect(() => parseSaleSignalFeedbackSummary({ signals: "non" })).toThrow();
  });
});

describe("unavailableSaleSignalFeedback", () => {
  it("dit « non mesuré » partout, jamais zéro", () => {
    const unavailable = unavailableSaleSignalFeedback();
    for (const counts of Object.values(unavailable.signals)) {
      expect([counts.total, counts.useful, counts.notRelevant, counts.accounts]).toEqual([
        null,
        null,
        null,
        null,
      ]);
      expect(Object.values(counts.reasons).every((value) => value === null)).toBe(true);
    }
  });
});

describe("getAdminSaleSignalFeedback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: raw, error: null });
  });

  it("lit l'agrégat pour un administrateur", async () => {
    const now = new Date("2026-11-10T12:00:00Z");

    const summary = await getAdminSaleSignalFeedback("token", now);

    expect(mocks.rpc).toHaveBeenCalledWith("admin_sale_signal_feedback_summary", {
      p_now: now.toISOString(),
    });
    expect(summary.signals.market_gap_band.total).toBe(12);
  });

  it("refuse un compte qui n'est pas administrateur, sans rien lire", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false });

    await expect(getAdminSaleSignalFeedback("token")).rejects.toThrow(/Forbidden/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rend « non mesuré » quand la fonction n'existe pas encore (migration non appliquée)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "absent" } });

    expect(await getAdminSaleSignalFeedback("token")).toEqual(unavailableSaleSignalFeedback());
  });

  it("lève sur une autre erreur de la base", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });

    await expect(getAdminSaleSignalFeedback("token")).rejects.toMatchObject({ code: "XX000" });
  });
});

const SALE = "c6230000-1000-4000-8000-000000000001";
const bySaleRaw = {
  generated_at: "2026-11-10T12:00:00Z",
  window_days: 90,
  rows: [
    {
      sale_id: SALE,
      title: "Appartement à Bordeaux",
      city: "Bordeaux",
      department: "33",
      signal: "pepite",
      reason: "criterion_wrong",
      count: 3,
      last_at: "2026-11-09T10:00:00Z",
      rule_version: "pepite-v1",
    },
    {
      sale_id: SALE,
      title: "Appartement à Bordeaux",
      city: null,
      department: null,
      signal: "points_to_verify",
      reason: "none",
      count: 1,
      last_at: null,
      rule_version: null,
    },
  ],
};

describe("parseSaleFeedbackBySale", () => {
  it("lit les retours par vente, signal et motif, avec la version de la règle de la pépite", () => {
    const parsed = parseSaleFeedbackBySale(bySaleRaw);
    expect(parsed.measured).toBe(true);
    expect(parsed.rows[0]).toEqual({
      saleId: SALE,
      title: "Appartement à Bordeaux",
      city: "Bordeaux",
      department: "33",
      signal: "pepite",
      reason: "criterion_wrong",
      count: 3,
      lastAt: "2026-11-09T10:00:00Z",
      ruleVersion: "pepite-v1",
    });
    expect(parsed.rows[1]).toMatchObject({ reason: "none", lastAt: null, ruleVersion: null });
  });

  it("ne garde jamais un identifiant de compte, même présent dans la réponse", () => {
    const parsed = parseSaleFeedbackBySale({
      ...bySaleRaw,
      rows: [{ ...bySaleRaw.rows[0], user_id: "secret-user" }],
    });
    expect(JSON.stringify(parsed)).not.toContain("secret-user");
  });

  it("refuse un signal inconnu", () => {
    expect(() =>
      parseSaleFeedbackBySale({ rows: [{ ...bySaleRaw.rows[0], signal: "autre" }] }),
    ).toThrow();
  });
});

describe("getAdminSaleFeedbackBySale", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: bySaleRaw, error: null });
  });

  it("lit les retours par vente pour un administrateur", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const result = await getAdminSaleFeedbackBySale("token", now);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_sale_signal_feedback_by_sale", {
      p_now: now.toISOString(),
      p_limit: 100,
    });
    expect(result.rows).toHaveLength(2);
  });

  it("refuse un compte qui n'est pas administrateur, sans rien lire", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false });
    await expect(getAdminSaleFeedbackBySale("token")).rejects.toThrow(/Forbidden/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rend « non mesuré » quand la fonction n'existe pas encore", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "absent" } });
    expect(await getAdminSaleFeedbackBySale("token")).toEqual(unavailableSaleFeedbackBySale());
  });
});
