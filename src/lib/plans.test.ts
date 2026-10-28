import { describe, expect, it } from "vitest";
import {
  featureIncluded,
  hasLiveStripeSubscription,
  hasStandingAnalysisAccess,
  isPlanPeriodActive,
  isTrialExtensionRow,
  pastDueGraceEnd,
  normalizePlanCode,
  PLAN_FEATURES,
  PLAN_LABELS,
  PLAN_LIMITS,
  SALE_UNLOCK_FEATURES,
  isSaleUnlockFeature,
} from "@/lib/plans";

describe("plan matrix", () => {
  it("exposes exactly Découverte and Analyse while folding legacy plans into Analyse", () => {
    expect(Object.keys(PLAN_LABELS)).toEqual(["decouverte", "analyse"]);
    expect(normalizePlanCode("investisseur")).toBe("analyse");
    expect(normalizePlanCode("analyse")).toBe("analyse");
    expect(normalizePlanCode("unknown")).toBe("decouverte");
  });

  it("keeps premium features locked while exposing lawyer discovery and one comparison", () => {
    const unexpectedlyUnlocked = Object.entries(PLAN_FEATURES.decouverte)
      .filter(
        (feature) =>
          ![
            "sales.filters",
            "alerts.advanced",
            "alerts.watchedZones",
            "sales.favorites",
            "sales.multiPropertyAnalysis",
            "lawyers.directory",
            // Public open data (Météo-France), read from local tables at no cost.
            "property.weatherHistory",
          ].includes(feature[0]),
      )
      .filter(([, access]) => access !== "locked");

    expect(unexpectedlyUnlocked).toEqual([]);
    expect(featureIncluded("decouverte", "lawyers.directory")).toBe(true);
    expect(PLAN_FEATURES.decouverte["sales.multiPropertyAnalysis"]).toBe("limited");
    expect(featureIncluded("decouverte", "lawyers.referrals")).toBe(false);
    expect(featureIncluded("decouverte", "property.outcomeGraph")).toBe(false);
    expect(featureIncluded("decouverte", "property.weatherHistory")).toBe(true);
    expect(PLAN_LIMITS.decouverte.propertyReportsPerMonth).toBe(0);
    expect(PLAN_LIMITS.decouverte.pdfExportsPerMonth).toBe(0);
    expect(PLAN_LIMITS.decouverte.favoriteSales).toBe(10);
    expect(PLAN_LIMITS.decouverte.saleAnalysisSets).toBe(1);
    expect(PLAN_LIMITS.decouverte.saleAnalysisItems).toBe(3);
  });

  it("grants three sale unlocks a month to Découverte, none to count for Analyse", () => {
    expect(PLAN_LIMITS.decouverte.monthlyUnlocks).toBe(3);
    expect(PLAN_LIMITS.analyse.monthlyUnlocks).toBeNull();
  });

  it("opens exactly the five elements of the unlocked page, and no autonomous estimate", () => {
    expect([...SALE_UNLOCK_FEATURES].sort()).toEqual([
      "property.advancedBidScenarios",
      "property.bidCeiling",
      "property.documentReading",
      "property.saleHistory",
      "sales.statistics",
    ]);
  });

  it("opens by unlock only the listed rights, which stay locked in the Découverte matrix", () => {
    for (const feature of SALE_UNLOCK_FEATURES) {
      expect(featureIncluded("decouverte", feature)).toBe(false);
      expect(isSaleUnlockFeature(feature)).toBe(true);
    }
    // Exports, saved reports and the other Analyse rights are never opened by an unlock.
    for (const feature of [
      "property.pdfExport",
      "sales.csvExport",
      "property.savedReports",
      "property.reportEditing",
      "property.valueEstimate",
      "property.outcomeGraph",
      "property.soldComparables",
      "property.activeComparables",
      "property.urbanPlanning",
      "property.cadastralAnalysis",
      "alerts.realtimeChanges",
      "workspace.collaboration",
      "sales.apiAccess",
      "lawyers.referrals",
    ] as const) {
      expect(isSaleUnlockFeature(feature)).toBe(false);
    }
  });

  it("unlocks all analysis and collaboration capabilities for Analyse", () => {
    expect(Object.values(PLAN_FEATURES.analyse).every((access) => access === "included")).toBe(
      true,
    );
    expect(featureIncluded("analyse", "property.valueEstimate")).toBe(true);
    expect(featureIncluded("analyse", "alerts.realtimeChanges")).toBe(true);
    expect(featureIncluded("analyse", "workspace.collaboration")).toBe(true);
    expect(featureIncluded("analyse", "property.outcomeGraph")).toBe(true);
    expect(featureIncluded("analyse", "property.weatherHistory")).toBe(true);
    expect(PLAN_LIMITS.analyse.workspaceCollaborators).toBeGreaterThan(0);
  });

  it("expires paid access at the end of its 30-day period", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(isPlanPeriodActive("active", "2026-07-11T10:00:00.000Z", now)).toBe(true);
    expect(isPlanPeriodActive("active", "2026-07-09T10:00:00.000Z", now)).toBe(false);
    expect(isPlanPeriodActive("expired", "2026-07-11T10:00:00.000Z", now)).toBe(false);
    expect(isPlanPeriodActive("active", null, now)).toBe(true);
  });

  it("keeps access for seven days after a failed renewal, then stops", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    // The paid period ended three days ago: still inside the grace period.
    expect(isPlanPeriodActive("past_due", "2026-07-07T10:00:00.000Z", now)).toBe(true);
    // Eight days ago: grace over.
    expect(isPlanPeriodActive("past_due", "2026-07-02T10:00:00.000Z", now)).toBe(false);
    // Without a known period end there is nothing to anchor the grace on.
    expect(isPlanPeriodActive("past_due", null, now)).toBe(false);
    expect(isPlanPeriodActive("cancelled", "2026-07-11T10:00:00.000Z", now)).toBe(false);
    expect(isPlanPeriodActive("paused", "2026-07-11T10:00:00.000Z", now)).toBe(false);
  });

  it("computes when the grace period ends", () => {
    expect(pastDueGraceEnd("2026-07-01T00:00:00.000Z")).toBe("2026-07-08T00:00:00.000Z");
    expect(pastDueGraceEnd(null)).toBeNull();
    expect(pastDueGraceEnd("not a date")).toBeNull();
  });

  it("sees a real Stripe subscription, not a customer left by an abandoned checkout", () => {
    const periodEnd = "2026-11-01T00:00:00.000Z";
    // Abandoned checkout: customer and reservation row (active, no period end).
    expect(hasLiveStripeSubscription({ status: "active", hasStripeCustomer: true }, null)).toBe(
      false,
    );
    expect(hasLiveStripeSubscription({ status: null, hasStripeCustomer: true }, null)).toBe(false);
    // Cancelled or expired subscriptions can be bought again.
    expect(
      hasLiveStripeSubscription({ status: "cancelled", hasStripeCustomer: true }, periodEnd),
    ).toBe(false);
    expect(
      hasLiveStripeSubscription({ status: "expired", hasStripeCustomer: true }, periodEnd),
    ).toBe(false);
    for (const status of ["past_due", "paused", "trialing", "active"] as const) {
      expect(hasLiveStripeSubscription({ status, hasStripeCustomer: true }, periodEnd)).toBe(true);
    }
    expect(
      hasLiveStripeSubscription({ status: "active", hasStripeCustomer: false }, periodEnd),
    ).toBe(false);
    expect(hasLiveStripeSubscription(undefined, periodEnd)).toBe(false);
  });
});

describe("hasStandingAnalysisAccess", () => {
  it("accepts an Analyse plan that does not come from the launch offer", () => {
    expect(hasStandingAnalysisAccess({ hasAnalysisAccess: true })).toBe(true);
  });

  it("refuses the launch offer, a free account and a missing plan", () => {
    expect(hasStandingAnalysisAccess({ hasAnalysisAccess: true, launchOffer: true })).toBe(false);
    expect(hasStandingAnalysisAccess({ hasAnalysisAccess: false })).toBe(false);
    expect(hasStandingAnalysisAccess(null)).toBe(false);
    expect(hasStandingAnalysisAccess(undefined)).toBe(false);
  });
});

describe("isTrialExtensionRow", () => {
  const grant = (source: string) => ({ manual_grant: { source } });

  it("reconnaît une prolongation d'essai sans abonnement Stripe", () => {
    expect(
      isTrialExtensionRow({
        stripe_subscription_id: null,
        metadata: grant("admin_trial_extension"),
      }),
    ).toBe(true);
    expect(isTrialExtensionRow({ metadata: grant("admin_trial_extension") })).toBe(true);
  });

  it("n'y voit ni un abonnement Stripe, ni une attribution ordinaire, ni une ligne vide", () => {
    expect(
      isTrialExtensionRow({
        stripe_subscription_id: "sub_1",
        metadata: grant("admin_trial_extension"),
      }),
    ).toBe(false);
    expect(isTrialExtensionRow({ metadata: grant("admin") })).toBe(false);
    expect(isTrialExtensionRow({ metadata: {} })).toBe(false);
    expect(isTrialExtensionRow({ metadata: [] })).toBe(false);
    expect(isTrialExtensionRow({ metadata: { manual_grant: "admin_trial_extension" } })).toBe(
      false,
    );
    expect(isTrialExtensionRow(null)).toBe(false);
  });

  it("n'est pas un droit durable : la prolongation est un essai", () => {
    expect(hasStandingAnalysisAccess({ hasAnalysisAccess: true, launchOffer: true })).toBe(false);
  });
});
