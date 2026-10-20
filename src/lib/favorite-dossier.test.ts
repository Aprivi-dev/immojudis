import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { PLAN_FEATURES, featureIncluded } from "@/lib/plans";
import {
  FAVORITE_DOSSIER_STATUSES,
  emptyFavoriteDossier,
  favoriteDossierInputSchema,
  favoriteDossierStatusLabel,
  formatBidCeilingInput,
  normalizeFavoriteDossierStatus,
  parseBidCeilingInput,
  toFavoriteDossier,
} from "@/lib/favorite-dossier-shared";
import { SALE_WORKSPACE_STATUSES } from "@/lib/sale-workspace-shared";

const mocks = vi.hoisted(() => ({
  assertFavorites: vi.fn(),
  maybeSingle: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/favorites", () => ({ assertSaleFavoritesAvailable: mocks.assertFavorites }));

import { getFavoriteDossier, saveFavoriteDossier } from "@/lib/favorite-dossier";

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const USER_ID = "user-1";

function auth(): SupabaseAuthContext {
  const query: Record<string, unknown> = {};
  query.select = (...args: unknown[]) => {
    mocks.select(...args);
    return query;
  };
  query.update = (...args: unknown[]) => {
    mocks.update(...args);
    return query;
  };
  query.eq = (...args: unknown[]) => {
    mocks.eq(...args);
    return query;
  };
  query.maybeSingle = mocks.maybeSingle;
  mocks.from.mockReturnValue(query);
  return { supabase: { from: mocks.from }, userId: USER_ID } as unknown as SupabaseAuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertFavorites.mockResolvedValue({ plan: "decouverte" });
});

describe("statuts de « Mon dossier »", () => {
  it("reprend exactement les statuts de l'espace de travail, avec leurs libellés", () => {
    expect(FAVORITE_DOSSIER_STATUSES).toEqual(SALE_WORKSPACE_STATUSES);
    expect(favoriteDossierStatusLabel("bidding")).toBe("Je prépare mon enchère");
  });

  it("traite une valeur inconnue comme absente", () => {
    expect(normalizeFavoriteDossierStatus("reviewing")).toBe("reviewing");
    expect(normalizeFavoriteDossierStatus("inconnu")).toBeNull();
    expect(normalizeFavoriteDossierStatus(null)).toBeNull();
    expect(normalizeFavoriteDossierStatus(12)).toBeNull();
  });
});

describe("favoriteDossierInputSchema", () => {
  it("accepte un statut, un plafond, ou les deux, et arrondit le plafond à l'euro", () => {
    expect(favoriteDossierInputSchema.parse({ saleId: SALE_ID, personalStatus: "won" })).toEqual({
      saleId: SALE_ID,
      personalStatus: "won",
    });
    expect(favoriteDossierInputSchema.parse({ saleId: SALE_ID, bidCeilingEur: 184_999.6 })).toEqual(
      { saleId: SALE_ID, bidCeilingEur: 185_000 },
    );
    expect(
      favoriteDossierInputSchema.parse({
        saleId: SALE_ID,
        personalStatus: null,
        bidCeilingEur: null,
      }),
    ).toEqual({ saleId: SALE_ID, personalStatus: null, bidCeilingEur: null });
  });

  it("refuse une demande vide, un statut inconnu, un plafond négatif ou démesuré", () => {
    expect(() => favoriteDossierInputSchema.parse({ saleId: SALE_ID })).toThrow();
    expect(() =>
      favoriteDossierInputSchema.parse({ saleId: SALE_ID, personalStatus: "bogus" }),
    ).toThrow();
    expect(() =>
      favoriteDossierInputSchema.parse({ saleId: SALE_ID, bidCeilingEur: -1 }),
    ).toThrow();
    expect(() =>
      favoriteDossierInputSchema.parse({ saleId: SALE_ID, bidCeilingEur: 10_000_000_001 }),
    ).toThrow();
    // Un plafond de 0 € n'est pas une enchère : on l'efface avec `null`.
    expect(() => favoriteDossierInputSchema.parse({ saleId: SALE_ID, bidCeilingEur: 0 })).toThrow(
      /supérieure à 0/,
    );
    expect(() =>
      favoriteDossierInputSchema.parse({ saleId: SALE_ID, bidCeilingEur: 0.4 }),
    ).toThrow();
    expect(() =>
      favoriteDossierInputSchema.parse({ saleId: SALE_ID, bidCeilingEur: Number.NaN }),
    ).toThrow();
    expect(() =>
      favoriteDossierInputSchema.parse({ saleId: "x", personalStatus: "won" }),
    ).toThrow();
  });
});

describe("parseBidCeilingInput", () => {
  it("lit les saisies françaises : espaces (insécables compris), « € », virgule", () => {
    expect(parseBidCeilingInput("185000")).toEqual({ ok: true, value: 185_000 });
    expect(parseBidCeilingInput("185 000")).toEqual({ ok: true, value: 185_000 });
    expect(parseBidCeilingInput("185\u202f000 €")).toEqual({ ok: true, value: 185_000 });
    expect(parseBidCeilingInput("185\u00a0000,6")).toEqual({ ok: true, value: 185_001 });
    expect(formatBidCeilingInput(185_000)).toMatch(/^185\s000$/);
  });

  it("refuse 0 €, le vide, le texte et un point de milliers (185.000)", () => {
    expect(parseBidCeilingInput("0")).toMatchObject({ ok: false });
    expect(parseBidCeilingInput("0,4")).toMatchObject({ ok: false });
    expect(parseBidCeilingInput("  ")).toMatchObject({ ok: false });
    expect(parseBidCeilingInput("abc")).toMatchObject({ ok: false });
    expect(parseBidCeilingInput("-5")).toMatchObject({ ok: false });
    expect(parseBidCeilingInput("185.000")).toMatchObject({ ok: false });
  });

  it("refuse un montant au-delà de la borne du serveur", () => {
    expect(parseBidCeilingInput("10000000001")).toMatchObject({ ok: false });
    expect(parseBidCeilingInput("10000000000")).toEqual({ ok: true, value: 10_000_000_000 });
  });
});

describe("toFavoriteDossier", () => {
  it("rend les valeurs absentes comme absentes", () => {
    expect(
      toFavoriteDossier({
        sale_id: SALE_ID,
        personal_status: null,
        personal_status_updated_at: null,
        bid_ceiling_eur: null,
        bid_ceiling_saved_at: null,
      }),
    ).toEqual({ ...emptyFavoriteDossier(SALE_ID), followed: true });
  });
});

describe("getFavoriteDossier", () => {
  it("lit la ligne du compte sur la vente, pour tout compte qui a les favoris", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        sale_id: SALE_ID,
        personal_status: "reviewing",
        personal_status_updated_at: "2026-10-19T10:00:00.000Z",
        bid_ceiling_eur: 185_000,
        bid_ceiling_saved_at: "2026-10-19T10:00:00.000Z",
      },
      error: null,
    });

    const response = await getFavoriteDossier({ auth: auth(), saleId: SALE_ID });

    expect(mocks.assertFavorites).toHaveBeenCalled();
    expect(mocks.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(mocks.eq).toHaveBeenCalledWith("sale_id", SALE_ID);
    expect(response.dossier).toMatchObject({
      followed: true,
      personalStatus: "reviewing",
      bidCeilingEur: 185_000,
    });
  });

  it("rend un dossier vide, non suivi, quand la vente n'est pas dans les favoris", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const response = await getFavoriteDossier({ auth: auth(), saleId: SALE_ID });
    expect(response.dossier).toEqual(emptyFavoriteDossier(SALE_ID));
  });
});

describe("saveFavoriteDossier", () => {
  it("n'écrit que les champs demandés, sur la ligne du compte", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        sale_id: SALE_ID,
        personal_status: null,
        personal_status_updated_at: null,
        bid_ceiling_eur: 185_000,
        bid_ceiling_saved_at: "2026-10-19T10:00:00.000Z",
      },
      error: null,
    });

    const response = await saveFavoriteDossier({
      auth: auth(),
      input: { saleId: SALE_ID, bidCeilingEur: 185_000 },
    });

    expect(mocks.update).toHaveBeenCalledWith({ bid_ceiling_eur: 185_000 });
    expect(mocks.eq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(mocks.eq).toHaveBeenCalledWith("sale_id", SALE_ID);
    expect(response.dossier.bidCeilingEur).toBe(185_000);
    expect(response.dossier.personalStatus).toBeNull();
  });

  it("efface une valeur avec null", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        sale_id: SALE_ID,
        personal_status: null,
        personal_status_updated_at: null,
        bid_ceiling_eur: null,
        bid_ceiling_saved_at: null,
      },
      error: null,
    });
    await saveFavoriteDossier({
      auth: auth(),
      input: { saleId: SALE_ID, personalStatus: null, bidCeilingEur: null },
    });
    expect(mocks.update).toHaveBeenCalledWith({ personal_status: null, bid_ceiling_eur: null });
  });

  it("refuse d'écrire sur une vente que le compte ne suit pas", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      saveFavoriteDossier({ auth: auth(), input: { saleId: SALE_ID, personalStatus: "won" } }),
    ).rejects.toMatchObject({ name: "PublicApiError", status: 404 });
    await expect(
      saveFavoriteDossier({ auth: auth(), input: { saleId: SALE_ID, personalStatus: "won" } }),
    ).rejects.toBeInstanceOf(PublicApiError);
  });

  it("remonte l'erreur de la base", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: new Error("boom") });
    await expect(
      saveFavoriteDossier({ auth: auth(), input: { saleId: SALE_ID, personalStatus: "won" } }),
    ).rejects.toThrow("boom");
  });

  it("reste ouvert au compte Découverte, sans ouvrir les outils d'analyse", () => {
    // Le droit exigé est celui des favoris, que l'offre Découverte inclut (dans sa limite).
    expect(featureIncluded("decouverte", "sales.favorites")).toBe(true);
    // La frontière avec Analyse ne bouge pas : l'espace de suivi et le rapport restent verrouillés.
    expect(PLAN_FEATURES.decouverte["workspace.audienceTracking"]).toBe("locked");
    expect(PLAN_FEATURES.decouverte["property.savedReports"]).toBe("locked");
    expect(PLAN_FEATURES.decouverte["property.advancedBidScenarios"]).toBe("locked");
  });
});
