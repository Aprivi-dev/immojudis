import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { buildActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import { buildAudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import { buildAuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { buildCadastralAnalysis, type StructuredCadastralParcel } from "@/lib/cadastre-analysis";
import { buildDemographicAnalysis } from "@/lib/demographic-analysis";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { normalizeDpeClass, type StructuredDpeDiagnostic } from "@/lib/dpe";
import {
  formatDate,
  formatPrice,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { getEnvironmentalContext, type EnvironmentalContext } from "@/lib/environment.functions";
import { estimateGrossYieldPct, pricePerM2 } from "@/lib/geo";
import { buildLegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { MarketEstimate } from "@/lib/market.functions";
import { buildMarketComparablesAnalysis } from "@/lib/market-comparables-analysis";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getPrecomputedMarketEstimate } from "@/lib/sale-market-estimates";
import {
  featureAccess,
  featureIncluded,
  isPlanPeriodActive,
  normalizePlanCode,
  PLAN_LABELS,
  PLAN_LIMITS,
  type FeatureAccess,
  type FeatureKey,
  type PlanCode,
} from "@/lib/plans";
import {
  computeAcquisitionCosts,
  computeRecommendedCeilings,
  computeRentabilityScore,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
} from "@/lib/profitability";
import { createTextPdf } from "@/lib/simple-pdf";
import {
  buildReportTraceability,
  REPORT_COMPLIANCE_NOTICE,
  type SourceTraceEntry,
} from "@/lib/source-traceability";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import { getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import {
  buildUrbanPlanningAnalysis,
  type StructuredUrbanPlanningSignal,
} from "@/lib/urban-planning-analysis";
import { assertUsageLimitAvailable, recordFeatureUsageEvent } from "@/lib/usage";
import { buildValuationAudit } from "@/lib/valuation-audit";
import {
  buildValuationBacktestForSale,
  type ValuationBacktestResult,
} from "@/lib/valuation-backtest";
import type {
  AuctionSale,
  SaleDocumentRich,
  SaleMedia,
  SaleRisk,
  SaleScoreFactor,
} from "@/lib/types";
import { ActiveComparableSales, PlanEntitlements } from "../property-reports";
import { asRecord } from "./serialization";
export function buildPlanEntitlements(
  plan: PlanCode,
  currentPeriodEnd: string | null = null,
  limits: PlanEntitlements["limits"] = PLAN_LIMITS[plan],
): PlanEntitlements {
  return {
    plan,
    label: PLAN_LABELS[plan],
    hasAnalysisAccess: plan === "analyse",
    currentPeriodEnd,
    limits,
    features: {
      salesStatistics: featureAccess(plan, "sales.statistics"),
      saleFavorites: featureAccess(plan, "sales.favorites"),
      salesCsvExport: featureAccess(plan, "sales.csvExport"),
      salesApiAccess: featureAccess(plan, "sales.apiAccess"),
      multiPropertyAnalysis: featureAccess(plan, "sales.multiPropertyAnalysis"),
      smartAlerts: featureAccess(plan, "alerts.advanced"),
      realtimeAlertChanges: featureAccess(plan, "alerts.realtimeChanges"),
      watchedZones: featureAccess(plan, "alerts.watchedZones"),
      dpeExplorer: featureAccess(plan, "dpe.latest"),
      marketDemographics: featureAccess(plan, "market.demographics"),
      marketPriceDistribution: featureAccess(plan, "market.priceDistribution"),
      valueEstimate: featureAccess(plan, "property.valueEstimate"),
      cadastralAnalysis: featureAccess(plan, "property.cadastralAnalysis"),
      nearbyServices: featureAccess(plan, "property.nearbyServices"),
      savedReports: featureAccess(plan, "property.savedReports"),
      pdfExport: featureAccess(plan, "property.pdfExport"),
      reportEditing: featureAccess(plan, "property.reportEditing"),
      urbanPlanning: featureAccess(plan, "property.urbanPlanning"),
      streetFacade: featureAccess(plan, "property.streetFacade"),
      saleHistory: featureAccess(plan, "property.saleHistory"),
      soldComparables: featureAccess(plan, "property.soldComparables"),
      activeComparables: featureAccess(plan, "property.activeComparables"),
      neighborhoodAnalysis: featureAccess(plan, "property.neighborhoodAnalysis"),
      bidCeiling: featureAccess(plan, "property.bidCeiling"),
      advancedBidScenarios: featureAccess(plan, "property.advancedBidScenarios"),
      dpeMap: featureAccess(plan, "dpe.map"),
      lawyerDirectory: featureAccess(plan, "lawyers.directory"),
      lawyerReferrals: featureAccess(plan, "lawyers.referrals"),
      audienceTracking: featureAccess(plan, "workspace.audienceTracking"),
      workspaceCollaboration: featureAccess(plan, "workspace.collaboration"),
    },
  };
}

export function assertEntitlementIncluded(
  plan: PlanEntitlements,
  feature: FeatureKey,
  message: string,
) {
  if (!featureIncluded(plan.plan, feature)) throw new Error(message);
}

export function featureUnlocked(access: FeatureAccess): boolean {
  return access !== "locked";
}

export function emptyActiveComparableSales(): ActiveComparableSales {
  return {
    scopeLabel: "Réservé au plan Analyse",
    sales: [],
  };
}

export function sanitizeReportSnapshotForPlan(
  snapshot: Record<string, unknown>,
  plan: PlanEntitlements,
): Record<string, unknown> {
  const analysis = asRecord(snapshot.analysis);
  const sanitizedAnalysis: Record<string, unknown> = {
    ...analysis,
    marketComparablesAnalysis: gateMarketComparablesAnalysis(
      asRecord(analysis.marketComparablesAnalysis),
      plan,
    ),
  };

  if (!featureUnlocked(plan.features.soldComparables)) {
    sanitizedAnalysis.valuationBacktest = null;
  }
  if (!featureUnlocked(plan.features.urbanPlanning)) {
    sanitizedAnalysis.urbanPlanningAnalysis = lockedUrbanPlanningAnalysis();
  }
  if (!featureUnlocked(plan.features.streetFacade)) {
    sanitizedAnalysis.streetFacadeAnalysis = lockedStreetFacadeAnalysis();
  }
  if (!featureUnlocked(plan.features.neighborhoodAnalysis)) {
    sanitizedAnalysis.neighborhoodAnalysis = lockedNeighborhoodAnalysis();
  }
  if (!featureUnlocked(plan.features.activeComparables)) {
    sanitizedAnalysis.activeComparablesAnalysis = lockedActiveComparablesAnalysis();
  }

  return {
    ...snapshot,
    analysis: sanitizedAnalysis,
    gatedFeatures: plan.features,
  };
}

export function gateMarketComparablesAnalysis<T extends object>(
  analysis: T,
  plan: PlanEntitlements,
): T {
  return {
    ...analysis,
    ...(!featureUnlocked(plan.features.soldComparables) ? { retainedComparables: [] } : {}),
    ...(!featureUnlocked(plan.features.saleHistory) ? { addressHistory: [] } : {}),
  } as T;
}

export function lockedUrbanPlanningAnalysis(): ReturnType<typeof buildUrbanPlanningAnalysis> {
  return {
    available: false,
    status: "missing",
    confidence: "low",
    confidenceLabel: "Réservé au plan Analyse",
    items: [],
    missingChecks: [],
    summary: "Fonctionnalité réservée au plan Analyse.",
    decisionImpact: "Débloquez l'analyse pour intégrer urbanisme, permis et servitudes.",
    nextActions: [],
    limitations: [],
  };
}

export function lockedStreetFacadeAnalysis(): ReturnType<typeof buildStreetFacadeAnalysis> {
  return {
    available: false,
    status: "missing",
    label: "Réservé au plan Analyse",
    locationQuality: "missing",
    confidence: "low",
    confidenceLabel: "Réservé au plan Analyse",
    addressLabel: null,
    coordinates: null,
    mapUrl: null,
    streetLevelUrl: null,
    aerial3dUrl: null,
    summary: "Fonctionnalité réservée au plan Analyse.",
    decisionImpact: "Débloquez l'analyse pour contrôler façade, rue et vues externes.",
    nextActions: [],
    limitations: [],
  };
}

export function lockedNeighborhoodAnalysis(): ReturnType<typeof buildNeighborhoodAnalysis> {
  return {
    available: false,
    status: "missing",
    label: "Réservé au plan Analyse",
    confidence: "low",
    confidenceLabel: "Réservé au plan Analyse",
    dimensions: [],
    marketPositionLabel: "Réservé au plan Analyse",
    serviceCoverageLabel: "Réservé au plan Analyse",
    locationQualityLabel: "Réservé au plan Analyse",
    signals: [],
    summary: "Fonctionnalité réservée au plan Analyse.",
    decisionImpact: "Débloquez l'analyse pour croiser marché, services, rue et signaux source.",
    nextActions: [],
    limitations: [],
  };
}

export function lockedActiveComparablesAnalysis(): ReturnType<
  typeof buildActiveComparablesAnalysis
> {
  return {
    available: false,
    status: "missing",
    confidence: "low",
    confidenceLabel: "Réservé au plan Analyse",
    scopeLabel: "Réservé au plan Analyse",
    items: [],
    summary: "Fonctionnalité réservée au plan Analyse.",
    decisionImpact: "Débloquez l'analyse pour comparer les biens encore en vente.",
    nextActions: [],
    limitations: [],
  };
}

export async function assertPdfExportAvailable(auth: SupabaseAuthContext, plan: PlanEntitlements) {
  await assertUsageLimitAvailable({
    auth,
    eventKey: "property_report.pdf_exported",
    limit: plan.limits.pdfExportsPerMonth,
    label: "PDF",
    planLabel: plan.label,
  });
}

export async function assertReportCreationAvailable(
  auth: SupabaseAuthContext,
  plan: PlanEntitlements,
) {
  await assertUsageLimitAvailable({
    auth,
    eventKey: "property_report.created",
    limit: plan.limits.propertyReportsPerMonth,
    label: "rapports mensuels",
    planLabel: plan.label,
  });
}
