import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const mocks = vi.hoisted(() => ({ hasUnlockedSale: vi.fn() }));
vi.mock("@/lib/sale-unlocks.server", () => ({ hasUnlockedSale: mocks.hasUnlockedSale }));

import { assertFeatureEntitlement, featureIncludedForSale } from "@/lib/property-reports";
import { SALE_UNLOCK_FEATURES, type FeatureKey } from "@/lib/plans";

const saleId = "11111111-1111-4111-8111-111111111111";

function discoveryAccount() {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  return {
    userId: "user-1",
    claims: {},
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
    supabase: { from: vi.fn().mockReturnValue(query) },
  } as unknown as SupabaseAuthContext;
}

function analysisAccount() {
  return {
    userId: "user-2",
    claims: {},
    accountTier: "premium",
    userRole: "user",
    isAdmin: false,
    supabase: {
      from() {
        throw new Error("A premium account never queries user_subscriptions.");
      },
    },
  } as unknown as SupabaseAuthContext;
}

describe("entitlement of an unlocked sale", () => {
  beforeEach(() => {
    mocks.hasUnlockedSale.mockReset();
  });

  it.each(SALE_UNLOCK_FEATURES)("lets an unlocked sale through for %s", async (feature) => {
    mocks.hasUnlockedSale.mockResolvedValue(true);
    const auth = discoveryAccount();
    await expect(
      assertFeatureEntitlement(auth, feature, "réservé", { saleId }),
    ).resolves.toMatchObject({
      plan: "decouverte",
    });
    expect(mocks.hasUnlockedSale).toHaveBeenCalledWith(auth, saleId);
  });

  it("refuses when this sale is not unlocked", async () => {
    mocks.hasUnlockedSale.mockResolvedValue(false);
    await expect(
      assertFeatureEntitlement(
        discoveryAccount(),
        "property.documentReading",
        "Lecture réservée.",
        {
          saleId,
        },
      ),
    ).rejects.toThrow("Lecture réservée.");
  });

  it("refuses without a sale: an offer-wide right is never opened by an unlock", async () => {
    mocks.hasUnlockedSale.mockResolvedValue(true);
    await expect(
      assertFeatureEntitlement(discoveryAccount(), "sales.statistics", "Statistiques réservées."),
    ).rejects.toThrow("Statistiques réservées.");
    expect(mocks.hasUnlockedSale).not.toHaveBeenCalled();
  });

  it.each<FeatureKey>([
    "property.pdfExport",
    "property.savedReports",
    "sales.csvExport",
    "property.soldComparables",
    "property.urbanPlanning",
    "alerts.realtimeChanges",
    "workspace.collaboration",
  ])("never opens %s, even for an unlocked sale", async (feature) => {
    mocks.hasUnlockedSale.mockResolvedValue(true);
    await expect(
      assertFeatureEntitlement(discoveryAccount(), feature, "Réservé à Analyse.", { saleId }),
    ).rejects.toThrow("Réservé à Analyse.");
    expect(mocks.hasUnlockedSale).not.toHaveBeenCalled();
  });

  it("does not ask the database about an Analyse account", async () => {
    await expect(
      assertFeatureEntitlement(analysisAccount(), "property.documentReading", "x", { saleId }),
    ).resolves.toMatchObject({ plan: "analyse" });
    expect(mocks.hasUnlockedSale).not.toHaveBeenCalled();
  });
});

describe("featureIncludedForSale", () => {
  beforeEach(() => {
    mocks.hasUnlockedSale.mockReset();
  });

  it("is true for Analyse without any database call", async () => {
    expect(await featureIncludedForSale(analysisAccount(), "property.saleHistory", saleId)).toBe(
      true,
    );
    expect(mocks.hasUnlockedSale).not.toHaveBeenCalled();
  });

  it("is true for a Découverte account on the sale it unlocked", async () => {
    mocks.hasUnlockedSale.mockResolvedValue(true);
    expect(await featureIncludedForSale(discoveryAccount(), "property.saleHistory", saleId)).toBe(
      true,
    );
  });

  it("is false for another sale, and for a right an unlock does not open", async () => {
    mocks.hasUnlockedSale.mockResolvedValue(false);
    expect(await featureIncludedForSale(discoveryAccount(), "property.saleHistory", saleId)).toBe(
      false,
    );
    mocks.hasUnlockedSale.mockResolvedValue(true);
    expect(await featureIncludedForSale(discoveryAccount(), "property.pdfExport", saleId)).toBe(
      false,
    );
  });
});
