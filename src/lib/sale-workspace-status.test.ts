import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  saveFavoriteDossier: vi.fn(),
  upsert: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/favorite-dossier", () => ({ saveFavoriteDossier: mocks.saveFavoriteDossier }));

import { saleWorkspaceInputSchema, upsertSaleWorkspace } from "@/lib/sale-workspaces";

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const USER_ID = "9b923d06-df18-403d-9c95-a4655f043825";

function auth(): SupabaseAuthContext {
  const row = {
    id: "20f72e0b-f67f-43a4-b1bd-a53978cbdd83",
    user_id: USER_ID,
    sale_id: SALE_ID,
    updated_at: "2026-10-20T09:00:00.000Z",
    private_notes: {},
    checklist: {},
    alert_preferences: {},
    document_reviews: {},
    tracking_status: "bidding",
  };
  const query = {
    upsert: (...args: unknown[]) => {
      mocks.upsert(...args);
      return query;
    },
    select: () => query,
    single: async () => ({ data: row, error: null }),
  };
  mocks.from.mockReturnValue(query);
  return { userId: USER_ID, supabase: { from: mocks.from } } as unknown as SupabaseAuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveFavoriteDossier.mockResolvedValue({ dossier: {} });
});

describe("PUT du dossier de travail : le statut passe par « Mon dossier »", () => {
  it("écrit le statut dans user_favorites.personal_status, puis garde la copie du dossier de travail", async () => {
    const input = saleWorkspaceInputSchema.parse({ saleId: SALE_ID, trackingStatus: "bidding" });
    const client = auth();
    await upsertSaleWorkspace({ auth: client, input });

    expect(mocks.saveFavoriteDossier).toHaveBeenCalledWith({
      auth: client,
      input: { saleId: SALE_ID, personalStatus: "bidding" },
    });
    expect(mocks.upsert.mock.calls[0]?.[0]).toMatchObject({
      sale_id: SALE_ID,
      tracking_status: "bidding",
    });
  });

  it("refuse clairement un statut sur une vente non suivie, sans rien écrire dans le dossier de travail", async () => {
    mocks.saveFavoriteDossier.mockRejectedValue(
      new PublicApiError(
        "Suivez d’abord cette vente (le cœur) pour enregistrer votre dossier.",
        404,
      ),
    );
    const input = saleWorkspaceInputSchema.parse({ saleId: SALE_ID, trackingStatus: "won" });

    await expect(upsertSaleWorkspace({ auth: auth(), input })).rejects.toMatchObject({
      message: expect.stringContaining("Suivez d’abord cette vente"),
      status: 404,
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("n'écrit pas dans « Mon dossier » quand la demande ne porte pas de statut", async () => {
    const input = saleWorkspaceInputSchema.parse({
      saleId: SALE_ID,
      privateNotes: { general: "Appeler l'avocat" },
    });
    await upsertSaleWorkspace({ auth: auth(), input });

    expect(mocks.saveFavoriteDossier).not.toHaveBeenCalled();
    expect(mocks.upsert.mock.calls[0]?.[0]).not.toHaveProperty("tracking_status", "bidding");
  });
});
