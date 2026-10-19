import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchOffer: vi.fn(),
  profilesOr: vi.fn(),
}));
vi.mock("@/lib/launch-offer.server", () => ({ isLaunchOfferActive: mocks.launchOffer }));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: vi.fn() }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => {
  function table(name: string) {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: async () => ({ data: [], error: null }),
      or: (filter: string) => {
        if (name === "user_profiles") mocks.profilesOr(filter);
        return query;
      },
    };
    return query;
  }
  return { supabaseAdmin: { from: table } };
});

import { runSaleChangeMonitorBatch } from "@/lib/sale-change-monitor";

describe("candidats du suivi des changements pendant l'offre de lancement", () => {
  beforeEach(() => {
    mocks.launchOffer.mockReset();
    mocks.profilesOr.mockReset();
  });

  it("sans l'offre, seuls les comptes premium ou administrateurs sont retenus (plus les abonnés)", async () => {
    mocks.launchOffer.mockResolvedValue(false);
    await runSaleChangeMonitorBatch();
    expect(mocks.profilesOr).toHaveBeenCalledWith("account_tier.eq.premium,user_role.eq.admin");
  });

  it("avec l'offre, tout compte qui a un profil a le suivi d'Analyse : aucun filtre sur le niveau", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    await runSaleChangeMonitorBatch();
    expect(mocks.profilesOr).not.toHaveBeenCalled();
  });
});
