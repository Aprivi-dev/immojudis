import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const mocks = vi.hoisted(() => ({
  launchOffer: vi.fn(),
  adminRows: vi.fn(),
}));
vi.mock("@/lib/launch-offer.server", () => ({ isLaunchOfferActive: mocks.launchOffer }));
vi.mock("@/lib/sale-unlocks.server", () => ({ hasUnlockedSale: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: mocks.adminRows(table), error: null }),
      };
      return query;
    },
  },
}));

import { PLAN_LIMITS } from "@/lib/plans";
import {
  assertFeatureEntitlement,
  resolvePlanEntitlements,
  shareOwnerKeepsSavedReports,
} from "@/lib/property-reports";

type Subscription = {
  plan_code: string;
  status: string;
  current_period_end: string | null;
  stripe_customer_id: string | null;
} | null;

function account({
  subscription = null,
  accountTier = "free",
  isAdmin = false,
  hasProfile,
}: {
  subscription?: Subscription;
  accountTier?: "free" | "premium";
  isAdmin?: boolean;
  hasProfile?: boolean;
} = {}) {
  const from = vi.fn(() => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: subscription, error: null }),
    };
    return query;
  });
  return {
    userId: "user-1",
    claims: {},
    accountTier,
    userRole: isAdmin ? "admin" : "user",
    isAdmin,
    ...(hasProfile === undefined ? {} : { hasProfile }),
    supabase: { from },
  } as unknown as SupabaseAuthContext;
}

const soon = new Date(Date.now() + 20 * 86_400_000).toISOString();

describe("plan effectif pendant l'offre de lancement", () => {
  beforeEach(() => {
    mocks.launchOffer.mockReset();
    mocks.adminRows.mockReset();
  });

  it("surclasse un compte gratuit en Analyse avec le marqueur d'affichage", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    const plan = await resolvePlanEntitlements(account({ hasProfile: true }));

    expect(plan.plan).toBe("analyse");
    expect(plan.hasAnalysisAccess).toBe(true);
    expect(plan.launchOffer).toBe(true);
    expect(plan.label).toBe("Analyse");
    // Les quotas de l'offre Analyse s'appliquent (rapports, PDF, actualisations : pas de plafond mensuel).
    expect(plan.limits).toEqual(PLAN_LIMITS.analyse);
    expect(plan.features.salesCsvExport).toBe("included");
    expect(plan.features.pdfExport).toBe("included");
    expect(plan.features.savedReports).toBe("included");
    expect(plan.features.bidCeiling).toBe("included");
  });

  it("reste Découverte quand l'offre est coupée : aucun marqueur, quotas gratuits", async () => {
    mocks.launchOffer.mockResolvedValue(false);
    const plan = await resolvePlanEntitlements(account({ hasProfile: true }));

    expect(plan.plan).toBe("decouverte");
    expect(plan.hasAnalysisAccess).toBe(false);
    expect(plan).not.toHaveProperty("launchOffer");
    expect(plan.limits).toEqual(PLAN_LIMITS.decouverte);
    expect(plan.features.pdfExport).toBe("locked");
  });

  it("n'accorde rien à un compte sans profil, comme la base", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    const plan = await resolvePlanEntitlements(account({ hasProfile: false }));
    expect(plan.plan).toBe("decouverte");
    expect(plan).not.toHaveProperty("launchOffer");
    expect(mocks.launchOffer).not.toHaveBeenCalled();
  });

  it("laisse un abonné, un compte premium et un administrateur à leur plan réel", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    const subscriber = await resolvePlanEntitlements(
      account({
        subscription: {
          plan_code: "analyse",
          status: "active",
          current_period_end: soon,
          stripe_customer_id: "cus_1",
        },
      }),
    );
    expect(subscriber.plan).toBe("analyse");
    expect(subscriber).not.toHaveProperty("launchOffer");
    expect(subscriber.currentPeriodEnd).toBe(soon);

    const premium = await resolvePlanEntitlements(account({ accountTier: "premium" }));
    expect(premium.plan).toBe("analyse");
    expect(premium).not.toHaveProperty("launchOffer");

    const admin = await resolvePlanEntitlements(account({ isAdmin: true }));
    expect(admin.plan).toBe("analyse");
    expect(admin).not.toHaveProperty("launchOffer");
    expect(mocks.launchOffer).not.toHaveBeenCalled();
  });

  it("garde les informations de paiement d'un ancien abonné pour que le portail reste accessible", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    const ended = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const plan = await resolvePlanEntitlements(
      account({
        subscription: {
          plan_code: "analyse",
          status: "past_due",
          current_period_end: ended,
          stripe_customer_id: "cus_1",
        },
      }),
    );
    expect(plan.launchOffer).toBe(true);
    expect(plan.billing).toMatchObject({ status: "past_due", hasStripeCustomer: true });
    expect(plan.currentPeriodEnd).toBe(ended);
  });

  it("ouvre les droits réservés à Analyse tant que l'offre dure, et les referme ensuite", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    await expect(
      assertFeatureEntitlement(account(), "property.pdfExport", "Export réservé."),
    ).resolves.toMatchObject({ plan: "analyse", launchOffer: true });

    mocks.launchOffer.mockResolvedValue(false);
    await expect(
      assertFeatureEntitlement(account(), "property.pdfExport", "Export réservé."),
    ).rejects.toThrow("Export réservé.");
  });
});

describe("liens de partage d'un compte gratuit", () => {
  beforeEach(() => {
    mocks.launchOffer.mockReset();
    mocks.adminRows.mockReset();
    mocks.adminRows.mockImplementation((table: string) =>
      table === "user_profiles" ? { account_tier: "free", user_role: "user" } : null,
    );
  });

  it("restent ouverts tant que l'offre de lancement dure", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    await expect(shareOwnerKeepsSavedReports("user-1")).resolves.toBe(true);
  });

  it("se referment avec elle", async () => {
    mocks.launchOffer.mockResolvedValue(false);
    await expect(shareOwnerKeepsSavedReports("user-1")).resolves.toBe(false);
  });

  it("ne sont pas ouverts à un propriétaire sans profil", async () => {
    mocks.adminRows.mockReturnValue(null);
    mocks.launchOffer.mockResolvedValue(true);
    await expect(shareOwnerKeepsSavedReports("user-1")).resolves.toBe(false);
  });
});
