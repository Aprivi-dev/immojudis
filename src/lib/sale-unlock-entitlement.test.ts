import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const mocks = vi.hoisted(() => ({ hasUnlockedSale: vi.fn(), publicationVisible: vi.fn() }));
vi.mock("@/lib/sale-unlocks.server", () => ({ hasUnlockedSale: mocks.hasUnlockedSale }));
vi.mock("@/lib/sale-publication-guard", () => ({
  assertSalePublicationVisible: mocks.publicationVisible,
}));

import { NotFoundError } from "@/lib/api-errors";
import {
  assertFeatureEntitlement,
  assertFeatureEntitlementVia,
  readSaleThroughDoor,
  saleFeatureDoor,
} from "@/lib/entitlements.server";
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
    "property.valueEstimate",
    "property.outcomeGraph",
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

describe("a right read in full for a sale (any door)", () => {
  beforeEach(() => {
    mocks.hasUnlockedSale.mockReset();
  });

  it("is true for Analyse without any database call", async () => {
    expect(await saleFeatureDoor(analysisAccount(), "property.saleHistory", saleId)).not.toBe(null);
    expect(mocks.hasUnlockedSale).not.toHaveBeenCalled();
  });

  it("is true for a Découverte account on the sale it unlocked", async () => {
    mocks.hasUnlockedSale.mockResolvedValue(true);
    expect(await saleFeatureDoor(discoveryAccount(), "property.saleHistory", saleId)).not.toBe(
      null,
    );
  });

  it("is false for another sale, and for a right an unlock does not open", async () => {
    mocks.hasUnlockedSale.mockResolvedValue(false);
    expect(await saleFeatureDoor(discoveryAccount(), "property.saleHistory", saleId)).toBe(null);
    mocks.hasUnlockedSale.mockResolvedValue(true);
    expect(await saleFeatureDoor(discoveryAccount(), "property.pdfExport", saleId)).toBe(null);
  });
});

describe("door of a right for a sale", () => {
  beforeEach(() => {
    mocks.hasUnlockedSale.mockReset();
  });

  it("tells the offer from the unlock", async () => {
    expect(await saleFeatureDoor(analysisAccount(), "property.documentReading", saleId)).toBe(
      "plan",
    );
    mocks.hasUnlockedSale.mockResolvedValue(true);
    expect(await saleFeatureDoor(discoveryAccount(), "property.documentReading", saleId)).toBe(
      "unlock",
    );
    mocks.hasUnlockedSale.mockResolvedValue(false);
    expect(await saleFeatureDoor(discoveryAccount(), "property.documentReading", saleId)).toBe(
      null,
    );
  });

  it("reports the unlock door when the right is granted by an unlock", async () => {
    mocks.hasUnlockedSale.mockResolvedValue(true);
    await expect(
      assertFeatureEntitlementVia(discoveryAccount(), "sales.statistics", "x", { saleId }),
    ).resolves.toMatchObject({ door: "unlock" });
    await expect(
      assertFeatureEntitlementVia(analysisAccount(), "sales.statistics", "x", { saleId }),
    ).resolves.toMatchObject({ door: "plan" });
  });
});

describe("sale read through a door", () => {
  function accountReading(row: Record<string, unknown> | null) {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: row, error: null });
    const from = vi.fn().mockReturnValue(query);
    return {
      auth: { userId: "user-1", supabase: { from } } as unknown as SupabaseAuthContext,
      from,
    };
  }

  beforeEach(() => {
    mocks.publicationVisible.mockReset();
    mocks.publicationVisible.mockResolvedValue(undefined);
  });

  it.each([
    ["plan", "v_auction_sales_app"],
    ["unlock", "v_auction_sales_unlocked"],
    [null, "v_auction_sales_discovery"],
  ] as const)("reads the view of the door %s, then checks the publication", async (door, view) => {
    const { auth, from } = accountReading({ id: saleId });

    await expect(readSaleThroughDoor(auth, saleId, door, "id")).resolves.toEqual({ id: saleId });

    expect(from).toHaveBeenCalledWith(view);
    expect(mocks.publicationVisible).toHaveBeenCalledWith(saleId);
  });

  it("answers 404 for a sale the session does not see, without the publication check", async () => {
    const { auth } = accountReading(null);

    await expect(readSaleThroughDoor(auth, saleId, "plan", "id")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(mocks.publicationVisible).not.toHaveBeenCalled();
  });

  it("hides a quarantined sale whatever the door", async () => {
    mocks.publicationVisible.mockRejectedValue(
      new NotFoundError("Vente introuvable ou inaccessible."),
    );
    const { auth } = accountReading({ id: saleId });

    await expect(readSaleThroughDoor(auth, saleId, "unlock", "id")).rejects.toMatchObject({
      status: 404,
    });
  });
});
