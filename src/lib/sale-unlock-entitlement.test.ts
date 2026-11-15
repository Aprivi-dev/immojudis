import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const mocks = vi.hoisted(() => ({
  hasUnlockedSale: vi.fn(),
  publicationVisible: vi.fn(),
  adminFrom: vi.fn(),
  getSale: vi.fn(),
}));
vi.mock("@/lib/sale-unlocks.server", () => ({ hasUnlockedSale: mocks.hasUnlockedSale }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock("@/lib/property-report/repository", () => ({ getSale: mocks.getSale }));
vi.mock("@/lib/sale-publication-guard", () => ({
  assertSalePublicationVisible: mocks.publicationVisible,
}));

import { NotFoundError } from "@/lib/api-errors";
import {
  assertFeatureEntitlement,
  assertFeatureEntitlementVia,
  getSaleForDoor,
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

  it.each(SALE_UNLOCK_FEATURES)(
    "opens %s for the unlocked sale X only, never for another sale Y",
    async (feature) => {
      const otherSaleId = "22222222-2222-4222-8222-222222222222";
      mocks.hasUnlockedSale.mockImplementation(async (_auth, id: string) => id === saleId);
      const auth = discoveryAccount();

      await expect(
        assertFeatureEntitlementVia(auth, feature, "réservé", { saleId }),
      ).resolves.toMatchObject({ door: "unlock" });
      await expect(
        assertFeatureEntitlementVia(auth, feature, "réservé", { saleId: otherSaleId }),
      ).rejects.toThrow("réservé");
    },
  );

  it("finds the sale lazily, only when the offer does not open the right", async () => {
    const saleOf = vi.fn(async () => saleId);
    mocks.hasUnlockedSale.mockResolvedValue(true);

    await expect(
      assertFeatureEntitlementVia(analysisAccount(), "property.pdfExport", "x", { saleId: saleOf }),
    ).resolves.toMatchObject({ door: "plan" });
    expect(saleOf).not.toHaveBeenCalled();

    await expect(
      assertFeatureEntitlementVia(discoveryAccount(), "property.pdfExport", "x", {
        saleId: saleOf,
      }),
    ).resolves.toMatchObject({ door: "unlock" });
    expect(saleOf).toHaveBeenCalledOnce();
    expect(mocks.hasUnlockedSale).toHaveBeenCalledWith(expect.anything(), saleId);

    // A right an unlock never opens does not even look for the sale.
    saleOf.mockClear();
    await expect(
      assertFeatureEntitlementVia(discoveryAccount(), "sales.csvExport", "x", { saleId: saleOf }),
    ).rejects.toThrow("x");
    expect(saleOf).not.toHaveBeenCalled();
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
    "dpe.latest",
    "dpe.map",
    "sales.csvExport",
    "alerts.realtimeChanges",
    "lawyers.referrals",
    "data.onDemandRefresh",
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
    expect(await saleFeatureDoor(discoveryAccount(), "sales.csvExport", saleId)).toBe(null);
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

describe("sale read for an Analyse route, by door", () => {
  const unlockedRow = {
    id: saleId,
    title: "Appartement",
    city: "Lyon",
    address: "3 rue de la Paix",
    postal_code: "69001",
    latitude: 45.76,
    longitude: 4.83,
    starting_price_eur: 90_000,
    // What the unlocked view already empties; set here to prove the server strips it again.
    investment_score: 82,
    score_confidence: 0.9,
    score_factors: [{ key: "price", label: "Prix", impact: 10 }],
    risk_notes: "Note interne du pipeline",
    risks: [{ risk_type: "occupation", risk_label: "Occupé" }],
    source_name: "licitor",
    primary_source: "licitor",
    source_url: "https://source.example/vente/1",
    source_urls: ["https://source.example/vente/1"],
    raw_payload: { listing: "brut" },
  };

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

  function adminReading(row: Record<string, unknown> | null) {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: row, error: null });
    mocks.adminFrom.mockReturnValue(query);
    return query;
  }

  beforeEach(() => {
    mocks.publicationVisible.mockReset();
    mocks.publicationVisible.mockResolvedValue(undefined);
    mocks.adminFrom.mockReset();
    mocks.getSale.mockReset();
  });

  it("reads the full sale with the session for the offer, as before", async () => {
    const sale = { id: saleId, source_url: "https://source.example/vente/1" };
    mocks.getSale.mockResolvedValue(sale);
    const { auth } = accountReading(null);

    await expect(getSaleForDoor(auth, saleId, "plan")).resolves.toEqual({
      sale,
      enrichmentKey: sale.source_url,
    });
    expect(mocks.getSale).toHaveBeenCalledWith(auth.supabase, saleId);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("reads an unlocked sale through the unlocked view, and never returns what the unlock does not open", async () => {
    const { auth, from } = accountReading(unlockedRow);
    const adminQuery = adminReading({ source_url: "https://source.example/vente/1" });

    const { sale, enrichmentKey } = await getSaleForDoor(auth, saleId, "unlock");

    expect(from).toHaveBeenCalledWith("v_auction_sales_unlocked");
    expect(mocks.publicationVisible).toHaveBeenCalledWith(saleId);
    expect(mocks.getSale).not.toHaveBeenCalled();
    // The service client reads the enrichment key alone, for this sale.
    expect(mocks.adminFrom).toHaveBeenCalledWith("auction_sales");
    expect(adminQuery.select).toHaveBeenCalledWith("source_url");
    expect(adminQuery.eq).toHaveBeenCalledWith("id", saleId);
    expect(enrichmentKey).toBe("https://source.example/vente/1");

    expect(sale).toMatchObject({
      id: saleId,
      city: "Lyon",
      latitude: 45.76,
      investment_score: null,
      score_confidence: null,
      score_factors: [],
      risk_notes: null,
      risks: [],
      source_name: null,
      primary_source: null,
      source_url: null,
      source_urls: [],
    });
    expect(sale).not.toHaveProperty("raw_payload");
    const text = JSON.stringify(sale);
    expect(text).not.toContain("source.example");
    expect(text).not.toContain("licitor");
    expect(text).not.toContain("Note interne");
  });

  it("answers 404 for a sale the account did not unlock, without the service client", async () => {
    const { auth } = accountReading(null);

    await expect(getSaleForDoor(auth, saleId, "unlock")).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("hides a quarantined unlocked sale before the service client reads anything", async () => {
    mocks.publicationVisible.mockRejectedValue(new NotFoundError("Vente introuvable."));
    const { auth } = accountReading(unlockedRow);

    await expect(getSaleForDoor(auth, saleId, "unlock")).rejects.toMatchObject({ status: 404 });
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });
});
