import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const mocks = vi.hoisted(() => ({
  launchOffer: vi.fn(),
  confirmedEmail: vi.fn(),
  /** Essai lu en base, quand un test veut une date de fin précise. */
  trial: vi.fn(),
  adminRows: vi.fn(),
}));
vi.mock("@/lib/launch-offer.server", () => ({
  // Essai en cours ou non (`confirmedEmail`), sans date de fin connue. La vraie lecture applique
  // l'interrupteur (`launchOffer`) : coupé, aucun essai, et aucun « refus » à signaler au compte.
  hasActiveSignupTrial: async (userId: string) =>
    Boolean((await mocks.launchOffer()) && (await mocks.confirmedEmail(userId))),
  readSignupTrial: async (userId: string) => {
    if (!(await mocks.launchOffer())) return { active: false, endsAt: null };
    return (
      (await mocks.trial(userId)) ?? {
        active: Boolean(await mocks.confirmedEmail(userId)),
        endsAt: null,
      }
    );
  },
}));
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

import { hasStandingAnalysisAccess, PLAN_LIMITS } from "@/lib/plans";
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
  stripe_subscription_id?: string | null;
  metadata?: Record<string, unknown>;
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
    mocks.confirmedEmail.mockReset();
    mocks.confirmedEmail.mockResolvedValue(true);
    mocks.trial.mockReset();
    mocks.adminRows.mockReset();
  });

  describe("dates de l'essai gratuit à l'inscription", () => {
    const endsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const endedAt = new Date(Date.now() - 86_400_000).toISOString();
    beforeEach(() => mocks.launchOffer.mockResolvedValue(true));

    it("donne la fin d'un essai en cours", async () => {
      mocks.trial.mockResolvedValueOnce({ active: true, endsAt });
      const plan = await resolvePlanEntitlements(account({ hasProfile: true }));
      expect(plan).toMatchObject({ plan: "analyse", launchOffer: true, trialEndsAt: endsAt });
      expect(plan).not.toHaveProperty("trialEndedAt");
    });

    it("revient à Découverte après l'essai, avec sa date de fin", async () => {
      mocks.trial.mockResolvedValueOnce({ active: false, endsAt: endedAt });
      const plan = await resolvePlanEntitlements(account({ hasProfile: true }));
      expect(plan).toMatchObject({ plan: "decouverte", trialEndedAt: endedAt });
      expect(plan).not.toHaveProperty("launchOffer");
      expect(plan.limits).toEqual(PLAN_LIMITS.decouverte);
    });

    it("signale un essai refusé par la base", async () => {
      mocks.trial.mockResolvedValueOnce({ active: false, endsAt: null, denied: true });
      const plan = await resolvePlanEntitlements(account({ hasProfile: true }));
      expect(plan).toMatchObject({ plan: "decouverte", trialDenied: true });
    });

    it("ne dit rien de l'essai quand l'interrupteur est coupé", async () => {
      mocks.launchOffer.mockResolvedValue(false);
      const plan = await resolvePlanEntitlements(account({ hasProfile: true }));
      expect(plan).not.toHaveProperty("trialEndedAt");
      expect(plan).not.toHaveProperty("trialDenied");
      expect(mocks.trial).not.toHaveBeenCalled();
    });
  });

  it("n'accorde rien à un compte dont l'email n'est pas confirmé, comme la base", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    mocks.confirmedEmail.mockResolvedValue(false);
    const plan = await resolvePlanEntitlements(account({ hasProfile: true }));

    expect(plan.plan).toBe("decouverte");
    expect(plan.hasAnalysisAccess).toBe(false);
    expect(plan).not.toHaveProperty("launchOffer");
    expect(plan.limits).toEqual(PLAN_LIMITS.decouverte);
    expect(mocks.confirmedEmail).toHaveBeenCalledWith("user-1");
    await expect(
      assertFeatureEntitlement(
        account({ hasProfile: true }),
        "property.pdfExport",
        "Export réservé.",
      ),
    ).rejects.toThrow("Export réservé.");
  });

  it("ne lit pas la confirmation de l'email quand l'offre est coupée ou que le plan est réel", async () => {
    mocks.launchOffer.mockResolvedValue(false);
    await resolvePlanEntitlements(account({ hasProfile: true }));
    mocks.launchOffer.mockResolvedValue(true);
    await resolvePlanEntitlements(account({ accountTier: "premium" }));
    await resolvePlanEntitlements(account({ isAdmin: true }));
    expect(mocks.confirmedEmail).not.toHaveBeenCalled();
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

  describe("prolongation d'essai par l'administrateur (ligne sans abonnement Stripe)", () => {
    const extensionEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const extensionRow = (overrides: Partial<NonNullable<Subscription>> = {}): Subscription => ({
      plan_code: "analyse",
      status: "trialing",
      current_period_end: extensionEnd,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      metadata: { manual_grant: { source: "admin_trial_extension" } },
      ...overrides,
    });

    it("est traitée comme un essai : marqueur, fin de la prolongation, aucun abonnement à gérer", async () => {
      mocks.launchOffer.mockResolvedValue(true);
      // Même un ancien client Stripe (checkout abandonné) n'ouvre ni portail ni résiliation.
      const plan = await resolvePlanEntitlements(
        account({ hasProfile: true, subscription: extensionRow({ stripe_customer_id: "cus_1" }) }),
      );
      expect(plan).toMatchObject({
        plan: "analyse",
        hasAnalysisAccess: true,
        launchOffer: true,
        trialExtension: true,
        trialEndsAt: extensionEnd,
        currentPeriodEnd: extensionEnd,
        billing: { status: "trialing", hasStripeCustomer: false, graceEndsAt: null },
      });
      expect(plan.limits).toEqual(PLAN_LIMITS.analyse);
      expect(hasStandingAnalysisAccess(plan)).toBe(false);
      expect(mocks.trial).not.toHaveBeenCalled();
    });

    it("ne dépend pas de l'interrupteur de l'essai : l'administrateur a décidé de la fin", async () => {
      mocks.launchOffer.mockResolvedValue(false);
      const plan = await resolvePlanEntitlements(
        account({ hasProfile: true, subscription: extensionRow() }),
      );
      expect(plan).toMatchObject({ plan: "analyse", launchOffer: true, trialExtension: true });
    });

    it("redevient Découverte à son terme, avec la date de fin de la prolongation et non celle de l'essai", async () => {
      mocks.launchOffer.mockResolvedValue(true);
      const naturalEnd = new Date(Date.now() - 20 * 86_400_000).toISOString();
      const extensionEnded = new Date(Date.now() - 2 * 86_400_000).toISOString();
      mocks.trial.mockResolvedValueOnce({ active: false, endsAt: naturalEnd });
      const plan = await resolvePlanEntitlements(
        account({
          hasProfile: true,
          subscription: extensionRow({ current_period_end: extensionEnded }),
        }),
      );
      expect(plan).toMatchObject({ plan: "decouverte", trialEndedAt: extensionEnded });
      expect(plan).not.toHaveProperty("launchOffer");
      expect(plan).not.toHaveProperty("trialExtension");
    });

    it("reste un abonnement ordinaire dès qu'un abonnement Stripe est rattaché", async () => {
      mocks.launchOffer.mockResolvedValue(true);
      const plan = await resolvePlanEntitlements(
        account({
          hasProfile: true,
          subscription: extensionRow({
            status: "active",
            stripe_customer_id: "cus_1",
            stripe_subscription_id: "sub_1",
          }),
        }),
      );
      expect(plan.plan).toBe("analyse");
      expect(plan).not.toHaveProperty("launchOffer");
      expect(plan.billing).toMatchObject({ hasStripeCustomer: true });
      expect(hasStandingAnalysisAccess(plan)).toBe(true);
    });

    it("ne confond pas une attribution manuelle ordinaire avec un essai", async () => {
      mocks.launchOffer.mockResolvedValue(true);
      const plan = await resolvePlanEntitlements(
        account({
          hasProfile: true,
          subscription: extensionRow({
            status: "active",
            metadata: { manual_grant: { source: "admin" } },
          }),
        }),
      );
      expect(plan).not.toHaveProperty("launchOffer");
      expect(hasStandingAnalysisAccess(plan)).toBe(true);
    });
  });
});

describe("liens de partage d'un compte gratuit", () => {
  beforeEach(() => {
    mocks.launchOffer.mockReset();
    mocks.confirmedEmail.mockReset();
    mocks.confirmedEmail.mockResolvedValue(true);
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

  it("ne sont pas ouverts à un propriétaire dont l'email n'est pas confirmé", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    mocks.confirmedEmail.mockResolvedValue(false);
    await expect(shareOwnerKeepsSavedReports("user-1")).resolves.toBe(false);
  });

  it("ne sont pas ouverts à un propriétaire sans profil", async () => {
    mocks.adminRows.mockReturnValue(null);
    mocks.launchOffer.mockResolvedValue(true);
    await expect(shareOwnerKeepsSavedReports("user-1")).resolves.toBe(false);
  });
});
