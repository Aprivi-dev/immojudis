import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SALE_UNLOCK_QUOTA_MESSAGE } from "@/lib/sale-unlock-quota-message";
import type { SaleUnlockStatus } from "@/lib/sale-unlocks";

vi.mock("@/integrations/supabase/lazy", () => ({
  hasSupabaseAuthHint: () => true,
  getSupabase: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) },
  }),
}));

import { SaleUnlockQuotaReachedError, unlockSaleRequest } from "./sale-analysis";

const saleId = "11111111-1111-4111-8111-111111111111";
const status: SaleUnlockStatus = {
  saleId,
  unlocked: false,
  unlockable: true,
  analysisAccess: false,
  limit: 1,
  used: 1,
  remaining: 0,
};
const fetchMock = vi.fn();

describe("unlockSaleRequest", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("quota atteint (409) : l'erreur porte le compteur et la phrase de la route", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: SALE_UNLOCK_QUOTA_MESSAGE, code: "unlock_quota_reached", status },
        { status: 409 },
      ),
    );

    const failure = await unlockSaleRequest(saleId).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SaleUnlockQuotaReachedError);
    expect(failure).toMatchObject({ message: SALE_UNLOCK_QUOTA_MESSAGE, status });
  });
});
