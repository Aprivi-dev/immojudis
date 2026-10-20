import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ plan: vi.fn(), deleted: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/account-product-events.server", () => ({ recordAccountProductEvent: vi.fn() }));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: mocks.usage }));

import { removeFavoriteSale } from "./favorites";

const saleId = "7d335032-e935-4550-9347-ed22b0f63449";
const auth = {
  userId: "user-1",
  supabase: {
    from: () => ({
      delete: () => ({
        eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: mocks.deleted }) }) }),
      }),
    }),
  },
} as never;

describe("retrait d'un favori : « Mon dossier » renvoyé pour « Annuler »", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.plan.mockResolvedValue({
      plan: "decouverte",
      label: "Découverte",
      limits: { favoriteSales: 10 },
    });
  });

  it("renvoie le statut et le plafond de la ligne supprimée", async () => {
    mocks.deleted.mockResolvedValue({
      data: { id: "fav-1", sale_id: saleId, personal_status: "bidding", bid_ceiling_eur: 185_000 },
      error: null,
    });

    const response = await removeFavoriteSale({ auth, input: { saleId } });

    expect(response.removed).toBe(true);
    expect(response.dossier).toEqual({ personalStatus: "bidding", bidCeilingEur: 185_000 });
    expect(mocks.usage).toHaveBeenCalledTimes(1);
  });

  it("traite un statut inconnu et un plafond absent comme absents", async () => {
    mocks.deleted.mockResolvedValue({
      data: { id: "fav-1", sale_id: saleId, personal_status: "inconnu", bid_ceiling_eur: null },
      error: null,
    });

    const response = await removeFavoriteSale({ auth, input: { saleId } });

    expect(response.dossier).toEqual({ personalStatus: null, bidCeilingEur: null });
  });

  it("ne renvoie aucun dossier quand il n'y avait rien à supprimer", async () => {
    mocks.deleted.mockResolvedValue({ data: null, error: null });

    const response = await removeFavoriteSale({ auth, input: { saleId } });

    expect(response).toMatchObject({ ok: true, removed: false, dossier: null });
    expect(mocks.usage).not.toHaveBeenCalled();
  });
});
