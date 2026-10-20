import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  daily: vi.fn(),
  count: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        is: async () => mocks.count(),
        insert: (row: unknown) => {
          mocks.insert(row);
          return query;
        },
        single: async () => ({
          data: {
            id: "key-1",
            name: "ma clé",
            key_prefix: "ij_live_abc",
            scopes: ["sales.feed:read"],
            last_used_at: null,
            revoked_at: null,
            expires_at: null,
            created_at: "2026-10-20T08:00:00Z",
          },
          error: null,
        }),
      };
      return query;
    },
  },
}));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/rate-limit", () => ({ enforceDailyOperationLimits: mocks.daily }));

import { createUserApiKey } from "@/lib/api-keys";

const request = new Request("https://immojudis.com/api/api-keys", { method: "POST" });
const auth = { userId: "user-1", claims: {} } as unknown as SupabaseAuthContext;
const input = { name: "ma clé" };
const analyse = { plan: "analyse", limits: { apiKeys: 3 } };

describe("plafond journalier de la création de clés d'API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.plan.mockResolvedValue(analyse);
    mocks.daily.mockResolvedValue(undefined);
    mocks.count.mockResolvedValue({ count: 0, error: null });
  });

  it("n'use aucun compteur sans droit d'accès, ni au-delà du nombre de clés du plan", async () => {
    mocks.plan.mockResolvedValue({ plan: "decouverte", limits: { apiKeys: 0 } });
    await expect(createUserApiKey({ auth, input, request })).rejects.toThrow("Clés API réservées");

    mocks.plan.mockResolvedValue(analyse);
    mocks.count.mockResolvedValue({ count: 3, error: null });
    await expect(createUserApiKey({ auth, input, request })).rejects.toThrow("Limite de 3 clés");
    expect(mocks.daily).not.toHaveBeenCalled();
  });

  it("applique le plafond du compte, de l'adresse et du site, avec la part de l'offre de lancement", async () => {
    await createUserApiKey({ auth, input, request });
    expect(mocks.daily).toHaveBeenLastCalledWith({
      request,
      userId: "user-1",
      operation: "apiKeyCreate",
      launchOffer: false,
    });
    mocks.plan.mockResolvedValue({ ...analyse, launchOffer: true });
    await createUserApiKey({ auth, input, request });
    expect(mocks.daily).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "apiKeyCreate", launchOffer: true }),
    );
  });

  it("ne crée aucune clé quand le plafond journalier est atteint", async () => {
    mocks.daily.mockRejectedValue(
      new RateLimitError(undefined, 3600, "Limite quotidienne atteinte, réessayez demain."),
    );
    await expect(createUserApiKey({ auth, input, request })).rejects.toBeInstanceOf(RateLimitError);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
