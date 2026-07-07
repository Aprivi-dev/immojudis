import { describe, expect, it } from "vitest";
import { featureIncluded, normalizePlanCode, PLAN_LABELS, PLAN_LIMITS } from "@/lib/plans";

describe("plan matrix", () => {
  it("supports the investor plan as a higher-capacity paid tier", () => {
    expect(normalizePlanCode("investisseur")).toBe("investisseur");
    expect(PLAN_LABELS.investisseur).toBe("Investisseur / Marchand");
    expect(PLAN_LIMITS.investisseur.watchedZones).toBeGreaterThan(
      PLAN_LIMITS.analyse.watchedZones ?? 0,
    );
    expect(PLAN_LIMITS.investisseur.saleAnalysisItems).toBeGreaterThan(
      PLAN_LIMITS.analyse.saleAnalysisItems ?? 0,
    );
    expect(PLAN_LIMITS.investisseur.apiKeys).toBeGreaterThan(PLAN_LIMITS.analyse.apiKeys ?? 0);
    expect(PLAN_LIMITS.investisseur.workspaceCollaborators).toBeGreaterThan(
      PLAN_LIMITS.analyse.workspaceCollaborators ?? 0,
    );
    expect(featureIncluded("investisseur", "sales.apiAccess")).toBe(true);
    expect(featureIncluded("decouverte", "sales.favorites")).toBe(false);
    expect(featureIncluded("analyse", "sales.favorites")).toBe(true);
    expect(featureIncluded("decouverte", "property.bidCeiling")).toBe(true);
    expect(featureIncluded("decouverte", "property.advancedBidScenarios")).toBe(false);
    expect(featureIncluded("analyse", "property.advancedBidScenarios")).toBe(true);
    expect(featureIncluded("decouverte", "property.streetFacade")).toBe(false);
    expect(featureIncluded("analyse", "property.streetFacade")).toBe(true);
    expect(featureIncluded("decouverte", "property.neighborhoodAnalysis")).toBe(false);
    expect(featureIncluded("analyse", "property.neighborhoodAnalysis")).toBe(true);
    expect(featureIncluded("decouverte", "property.activeComparables")).toBe(false);
    expect(featureIncluded("analyse", "property.activeComparables")).toBe(true);
    expect(featureIncluded("decouverte", "property.urbanPlanning")).toBe(false);
    expect(featureIncluded("analyse", "property.urbanPlanning")).toBe(true);
    expect(featureIncluded("decouverte", "market.demographics")).toBe(true);
    expect(featureIncluded("analyse", "market.demographics")).toBe(true);
    expect(featureIncluded("decouverte", "workspace.audienceTracking")).toBe(false);
    expect(featureIncluded("analyse", "workspace.audienceTracking")).toBe(true);
    expect(featureIncluded("decouverte", "data.onDemandRefresh")).toBe(false);
    expect(featureIncluded("analyse", "data.onDemandRefresh")).toBe(true);
    expect(featureIncluded("analyse", "alerts.realtimeChanges")).toBe(false);
    expect(featureIncluded("investisseur", "alerts.realtimeChanges")).toBe(true);
    expect(featureIncluded("analyse", "workspace.collaboration")).toBe(false);
    expect(featureIncluded("investisseur", "workspace.collaboration")).toBe(true);
    expect(featureIncluded("decouverte", "lawyers.directory")).toBe(true);
    expect(featureIncluded("decouverte", "lawyers.referrals")).toBe(false);
    expect(featureIncluded("analyse", "lawyers.referrals")).toBe(true);
    expect(featureIncluded("investisseur", "lawyers.referrals")).toBe(true);
  });
});
