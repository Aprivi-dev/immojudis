import { ForbiddenError } from "@/lib/api-errors";
import { buildActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import type { SaleFeatureDoor } from "@/lib/entitlements.server";
import {
  featureAccess,
  featureIncluded,
  isSaleUnlockFeature,
  PLAN_LABELS,
  PLAN_LIMITS,
  type FeatureAccess,
  type FeatureKey,
  type PlanBilling,
  type PlanCode,
  type PlanEntitlements,
} from "@/lib/plans";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import { buildUrbanPlanningAnalysis } from "@/lib/urban-planning-analysis";
import type { ActiveComparableSales } from "../property-reports";
import { asRecord } from "@/lib/guards";
import type { AuctionSale } from "@/lib/types";
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
    features: planFeatures((feature) => featureAccess(plan, feature)),
  };
}

function planFeatures(
  access: (feature: FeatureKey) => FeatureAccess,
): PlanEntitlements["features"] {
  return {
    salesStatistics: access("sales.statistics"),
    saleFavorites: access("sales.favorites"),
    salesCsvExport: access("sales.csvExport"),
    salesApiAccess: access("sales.apiAccess"),
    multiPropertyAnalysis: access("sales.multiPropertyAnalysis"),
    smartAlerts: access("alerts.advanced"),
    realtimeAlertChanges: access("alerts.realtimeChanges"),
    watchedZones: access("alerts.watchedZones"),
    dpeExplorer: access("dpe.latest"),
    marketDemographics: access("market.demographics"),
    marketPriceDistribution: access("market.priceDistribution"),
    valueEstimate: access("property.valueEstimate"),
    cadastralAnalysis: access("property.cadastralAnalysis"),
    nearbyServices: access("property.nearbyServices"),
    savedReports: access("property.savedReports"),
    pdfExport: access("property.pdfExport"),
    reportEditing: access("property.reportEditing"),
    urbanPlanning: access("property.urbanPlanning"),
    streetFacade: access("property.streetFacade"),
    saleHistory: access("property.saleHistory"),
    soldComparables: access("property.soldComparables"),
    activeComparables: access("property.activeComparables"),
    neighborhoodAnalysis: access("property.neighborhoodAnalysis"),
    outcomeGraph: access("property.outcomeGraph"),
    bidCeiling: access("property.bidCeiling"),
    advancedBidScenarios: access("property.advancedBidScenarios"),
    dpeMap: access("dpe.map"),
    lawyerDirectory: access("lawyers.directory"),
    lawyerReferrals: access("lawyers.referrals"),
    audienceTracking: access("workspace.audienceTracking"),
    workspaceCollaboration: access("workspace.collaboration"),
  };
}

/**
 * Whether `feature` is open for a sale reached through `door`: the rights of the offer, plus, for the
 * unlock of this sale, those of `SALE_UNLOCK_FEATURES`. The same rule as `doorFor`
 * (`entitlements.server.ts`), once the door is known.
 */
export function featureOpenFor(
  plan: PlanEntitlements,
  door: SaleFeatureDoor,
  feature: FeatureKey,
): boolean {
  return featureIncluded(plan.plan, feature) || (door === "unlock" && isSaleUnlockFeature(feature));
}

/**
 * The rights shown with a sale reached through `door`. For an unlock, the rights it opens read
 * « included », and the report and PDF quotas of Découverte (0 a month, a display value that blocks
 * nothing) are not shown: the daily caps (`enforceDailyOperationLimits`) are the only ones.
 */
export function planForSaleDoor(plan: PlanEntitlements, door: SaleFeatureDoor): PlanEntitlements {
  if (door === "plan") return plan;
  return {
    ...plan,
    limits: {
      ...plan.limits,
      propertyReportsPerMonth: null,
      pdfExportsPerMonth: null,
      reportEditing: "full",
    },
    features: planFeatures((feature) =>
      isSaleUnlockFeature(feature) ? "included" : featureAccess(plan.plan, feature),
    ),
  };
}

/**
 * What the unlock of a sale never opens, removed from the sale before any response or report: the
 * investment score and its factors, the risks and the pipeline's risk notes, the source names and
 * urls, the raw payload. The columns `v_auction_sales_unlocked` empties, applied again on the server
 * side so that a sale read for an unlock carries none of them whatever its origin. The source also
 * travels inside `sale_procedure` (`unlockedSaleProcedure`): it is removed there too.
 */
export function unlockedSaleProjection(sale: AuctionSale): AuctionSale {
  const {
    sale_procedure: saleProcedure,
    source_blocks: sourceBlocks,
    raw_payload: _rawPayload,
    premium_readiness_score: _readinessScore,
    premium_readiness_status: _readinessStatus,
    premium_readiness_policy_version: _readinessPolicy,
    premium_readiness_factors: _readinessFactors,
    premium_readiness_blockers: _readinessBlockers,
    premium_readiness_missing_fields: _readinessMissing,
    premium_readiness_evaluated_at: _readinessEvaluatedAt,
    ...rest
  } = sale;
  return {
    ...rest,
    ...(saleProcedure === undefined
      ? {}
      : { sale_procedure: unlockedSaleProcedure(saleProcedure) as AuctionSale["sale_procedure"] }),
    source_blocks:
      sourceBlocks && "sale_procedure" in sourceBlocks
        ? { ...sourceBlocks, sale_procedure: unlockedSaleProcedure(sourceBlocks.sale_procedure) }
        : sourceBlocks,
    investment_score: null,
    investment_summary: null,
    score_version: null,
    score_confidence: null,
    score_factors: [],
    risk_notes: null,
    risks: [],
    source_name: null,
    primary_source: null,
    source_url: null,
    source_urls: [],
    dedupe_confidence: null,
    quality_flags: [],
  };
}

/**
 * Kinds of `sale_procedure.verification.case_sources` an unlock may show, as the pipeline writes them
 * (`_case_sources`, `services/data-pipeline/src/sale_procedure.py`): the case documents and the
 * official reference of the competent court. The `listing` entry carries the source url and name;
 * any other or unknown kind is removed too (closed by default).
 */
const UNLOCK_CASE_SOURCE_KINDS: ReadonlySet<unknown> = new Set(["document", "official_reference"]);

/**
 * `sale_procedure` without the listing source: the case sources outside `UNLOCK_CASE_SOURCE_KINDS`,
 * the listing platform's name on the documents (the pipeline copies `source_name` there), and every
 * `…source_url` key (schedule, payment deadline, facts: the pipeline fills them with the listing url).
 */
function unlockedSaleProcedure(value: unknown): unknown {
  const procedure = withoutSourceUrlKeys(value);
  if (!procedure || typeof procedure !== "object" || Array.isArray(procedure)) return procedure;
  const record = procedure as Record<string, unknown>;
  const verification = record.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    return record;
  }
  const caseSources = (verification as Record<string, unknown>).case_sources;
  if (!Array.isArray(caseSources)) return record;
  return {
    ...record,
    verification: {
      ...verification,
      case_sources: caseSources
        .filter((source) => UNLOCK_CASE_SOURCE_KINDS.has(asRecord(source).kind))
        .map((source) => {
          const entry = asRecord(source);
          if (entry.kind === "official_reference") return entry;
          const { source_name: _listingSourceName, ...document } = entry;
          return document;
        }),
    },
  };
}

function withoutSourceUrlKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSourceUrlKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.endsWith("source_url"))
      .map(([key, item]) => [key, withoutSourceUrlKeys(item)]),
  );
}

/**
 * Urban planning signals an unlock may show, by `source_kind` as the pipeline writes them
 * (`_collect_text_candidates`, `services/data-pipeline/src/urban_planning.py`): the case pieces
 * (`document`, `pdf`) and the listing's title and description (`sale_text` from « Titre annonce » or
 * « Description annonce »), all already served with the sale. Removed: `source_payload` (leaves of the
 * raw payload and other sources' observations), the raw text of the source (`sale_text` « Texte
 * source »), and any other or unknown kind (closed by default).
 */
const UNLOCK_SIGNAL_SOURCE_KINDS: ReadonlySet<unknown> = new Set(["document", "pdf"]);
const UNLOCK_SALE_TEXT_SOURCES: ReadonlySet<unknown> = new Set([
  "Titre annonce",
  "Description annonce",
]);

export function urbanPlanningSignalsForDoor<
  Signal extends { sourceKind?: string | null; sourceName?: string | null },
>(signals: Signal[], door: SaleFeatureDoor): Signal[] {
  if (door === "plan") return signals;
  return signals.filter(
    (signal) =>
      UNLOCK_SIGNAL_SOURCE_KINDS.has(signal.sourceKind) ||
      (signal.sourceKind === "sale_text" && UNLOCK_SALE_TEXT_SOURCES.has(signal.sourceName)),
  );
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

/**
 * Locks the sections of a saved snapshot that `plan`, through `door`, does not open. An unlock opens
 * every section of its sale's report (`SALE_UNLOCK_FEATURES`).
 */
export function sanitizeReportSnapshotForPlan(
  snapshot: Record<string, unknown>,
  plan: PlanEntitlements,
  door: SaleFeatureDoor,
): Record<string, unknown> {
  const open = (feature: FeatureKey) => featureOpenFor(plan, door, feature);
  const analysis = asRecord(snapshot.analysis);
  const sanitizedAnalysis: Record<string, unknown> = {
    ...analysis,
    marketComparablesAnalysis: gateMarketComparablesAnalysis(
      asRecord(analysis.marketComparablesAnalysis),
      plan,
      door,
    ),
  };

  if (!open("property.soldComparables")) {
    sanitizedAnalysis.valuationBacktest = null;
  }
  if (!open("property.urbanPlanning")) {
    sanitizedAnalysis.urbanPlanningAnalysis = lockedUrbanPlanningAnalysis();
  }
  if (!open("property.streetFacade")) {
    sanitizedAnalysis.streetFacadeAnalysis = lockedStreetFacadeAnalysis();
  }
  if (!open("property.neighborhoodAnalysis")) {
    sanitizedAnalysis.neighborhoodAnalysis = lockedNeighborhoodAnalysis();
  }
  if (!open("property.activeComparables")) {
    sanitizedAnalysis.activeComparablesAnalysis = lockedActiveComparablesAnalysis();
  }

  return {
    ...snapshot,
    analysis: sanitizedAnalysis,
    gatedFeatures: planForSaleDoor(plan, door).features,
  };
}

export function gateMarketComparablesAnalysis<T extends object>(
  analysis: T,
  plan: PlanEntitlements,
  door: SaleFeatureDoor,
): T {
  return {
    ...analysis,
    ...(!featureOpenFor(plan, door, "property.soldComparables") ? { retainedComparables: [] } : {}),
    ...(!featureOpenFor(plan, door, "property.saleHistory") ? { addressHistory: [] } : {}),
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
