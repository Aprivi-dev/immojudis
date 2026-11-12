import { ForbiddenError } from "@/lib/api-errors";
import { buildActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import {
  featureAccess,
  featureIncluded,
  PLAN_LABELS,
  PLAN_LIMITS,
  type FeatureKey,
  type PlanBilling,
  type PlanCode,
  type PlanEntitlements,
} from "@/lib/plans";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import { buildUrbanPlanningAnalysis } from "@/lib/urban-planning-analysis";
import type { ActiveComparableSales } from "../property-reports";
import { asRecord } from "@/lib/guards";
export function buildPlanEntitlements(
  plan: PlanCode,
  currentPeriodEnd: string | null = null,
  limits: PlanEntitlements["limits"] = PLAN_LIMITS[plan],
  billing?: PlanBilling,
  options: {
    launchOffer?: boolean;
    trialEndsAt?: string | null;
    trialEndedAt?: string | null;
    trialDenied?: boolean;
    trialExtension?: boolean;
  } = {},
): PlanEntitlements {
  return {
    plan,
    label: PLAN_LABELS[plan],
    hasAnalysisAccess: plan === "analyse",
    currentPeriodEnd,
    ...(billing ? { billing } : {}),
    // Marqueurs d'affichage : le plan est Analyse pendant l'essai gratuit à l'inscription (pas
    // parce que le compte est abonné ou premium), ou l'essai est fini ou refusé.
    ...(options.launchOffer ? { launchOffer: true as const } : {}),
    ...(options.launchOffer && options.trialEndsAt ? { trialEndsAt: options.trialEndsAt } : {}),
    ...(options.launchOffer && options.trialExtension ? { trialExtension: true as const } : {}),
    ...(!options.launchOffer && options.trialEndedAt ? { trialEndedAt: options.trialEndedAt } : {}),
    ...(!options.launchOffer && options.trialDenied ? { trialDenied: true as const } : {}),
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
      outcomeGraph: featureAccess(plan, "property.outcomeGraph"),
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
  if (!featureIncluded(plan.plan, feature)) throw new ForbiddenError(message);
}

export function emptyActiveComparableSales(): ActiveComparableSales {
  return {
    scopeLabel: "Réservé à l’offre Analyse",
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

  if (!featureIncluded(plan.plan, "property.soldComparables")) {
    sanitizedAnalysis.valuationBacktest = null;
  }
  if (!featureIncluded(plan.plan, "property.urbanPlanning")) {
    sanitizedAnalysis.urbanPlanningAnalysis = lockedUrbanPlanningAnalysis();
  }
  if (!featureIncluded(plan.plan, "property.streetFacade")) {
    sanitizedAnalysis.streetFacadeAnalysis = lockedStreetFacadeAnalysis();
  }
  if (!featureIncluded(plan.plan, "property.neighborhoodAnalysis")) {
    sanitizedAnalysis.neighborhoodAnalysis = lockedNeighborhoodAnalysis();
  }
  if (!featureIncluded(plan.plan, "property.activeComparables")) {
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
    ...(!featureIncluded(plan.plan, "property.soldComparables") ? { retainedComparables: [] } : {}),
    ...(!featureIncluded(plan.plan, "property.saleHistory") ? { addressHistory: [] } : {}),
  } as T;
}

export function lockedUrbanPlanningAnalysis(): ReturnType<typeof buildUrbanPlanningAnalysis> {
  return {
    available: false,
    status: "missing",
    confidence: "low",
    confidenceLabel: "Réservé à l’offre Analyse",
    items: [],
    missingChecks: [],
    summary: "Fonctionnalité réservée à l’offre Analyse.",
    decisionImpact: "Débloquez l'analyse pour intégrer urbanisme, permis et servitudes.",
    nextActions: [],
    limitations: [],
  };
}

export function lockedStreetFacadeAnalysis(): ReturnType<typeof buildStreetFacadeAnalysis> {
  return {
    available: false,
    status: "missing",
    label: "Réservé à l’offre Analyse",
    locationQuality: "missing",
    confidence: "low",
    confidenceLabel: "Réservé à l’offre Analyse",
    addressLabel: null,
    coordinates: null,
    mapUrl: null,
    streetLevelUrl: null,
    aerial3dUrl: null,
    summary: "Fonctionnalité réservée à l’offre Analyse.",
    decisionImpact: "Débloquez l'analyse pour contrôler façade, rue et vues externes.",
    nextActions: [],
    limitations: [],
  };
}

export function lockedNeighborhoodAnalysis(): ReturnType<typeof buildNeighborhoodAnalysis> {
  return {
    available: false,
    status: "missing",
    label: "Réservé à l’offre Analyse",
    confidence: "low",
    confidenceLabel: "Réservé à l’offre Analyse",
    dimensions: [],
    marketPositionLabel: "Réservé à l’offre Analyse",
    serviceCoverageLabel: "Réservé à l’offre Analyse",
    locationQualityLabel: "Réservé à l’offre Analyse",
    signals: [],
    summary: "Fonctionnalité réservée à l’offre Analyse.",
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
    confidenceLabel: "Réservé à l’offre Analyse",
    scopeLabel: "Réservé à l’offre Analyse",
    items: [],
    summary: "Fonctionnalité réservée à l’offre Analyse.",
    decisionImpact: "Débloquez l'analyse pour comparer les biens encore en vente.",
    nextActions: [],
    limitations: [],
  };
}
