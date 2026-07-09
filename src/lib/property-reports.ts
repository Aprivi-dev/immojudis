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
import { getMarketEstimate, type MarketEstimate } from "@/lib/market.functions";
import { buildMarketComparablesAnalysis } from "@/lib/market-comparables-analysis";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";
import { cleanSaleTitle } from "@/lib/sale-title";
import {
  featureAccess,
  isActivePlanStatus,
  normalizePlanCode,
  PLAN_LABELS,
  PLAN_LIMITS,
  type FeatureAccess,
  type PlanCode,
} from "@/lib/plans";
import {
  computeAcquisitionCosts,
  computeMarketCeiling,
  computeRentabilityScore,
  DEFAULTS,
} from "@/lib/profitability";
import { createTextPdf } from "@/lib/simple-pdf";
import {
  buildReportTraceability,
  REPORT_COMPLIANCE_NOTICE,
  type SourceTraceEntry,
} from "@/lib/source-traceability";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import { getSaleSurface } from "@/lib/surface";
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
import { hasAdminRole } from "@/lib/account";

type SupabaseClient = SupabaseAuthContext["supabase"];
type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];
type SavedReportRow = Database["public"]["Tables"]["saved_property_reports"]["Row"];
type CadastreParcelRow = Database["public"]["Tables"]["auction_cadastre_parcels"]["Row"];
type DpeDiagnosticRow = Database["public"]["Tables"]["auction_dpe_diagnostics"]["Row"];
type UrbanPlanningSignalRow = Database["public"]["Tables"]["auction_urban_planning_signals"]["Row"];
type ActiveComparableSales = {
  scopeLabel: string;
  sales: AuctionSale[];
};

export const propertyReportRequestSchema = z.object({
  saleId: z.string().uuid(),
  reportKind: z.enum(["opportunity", "market", "bid_ceiling"]).default("opportunity"),
  title: z.string().trim().min(3).max(140).optional(),
  userNotes: z.string().trim().max(2500).optional(),
  includeEnvironment: z.boolean().default(false),
});

export const propertyReportUpdateSchema = z.object({
  title: z.string().trim().min(3).max(140).optional(),
  userNotes: z.string().trim().max(2500).nullable().optional(),
});

export type PropertyReportRequestInput = z.input<typeof propertyReportRequestSchema>;
export type PropertyReportRequestPayload = z.output<typeof propertyReportRequestSchema>;
export type PropertyReportUpdateInput = z.input<typeof propertyReportUpdateSchema>;
export type PropertyReportUpdatePayload = z.output<typeof propertyReportUpdateSchema>;

export type PlanEntitlements = {
  plan: PlanCode;
  label: string;
  limits: (typeof PLAN_LIMITS)[PlanCode];
  features: {
    salesStatistics: FeatureAccess;
    saleFavorites: FeatureAccess;
    salesCsvExport: FeatureAccess;
    salesApiAccess: FeatureAccess;
    multiPropertyAnalysis: FeatureAccess;
    smartAlerts: FeatureAccess;
    realtimeAlertChanges: FeatureAccess;
    watchedZones: FeatureAccess;
    dpeExplorer: FeatureAccess;
    marketDemographics: FeatureAccess;
    marketPriceDistribution: FeatureAccess;
    pdfExport: FeatureAccess;
    reportEditing: FeatureAccess;
    urbanPlanning: FeatureAccess;
    streetFacade: FeatureAccess;
    saleHistory: FeatureAccess;
    soldComparables: FeatureAccess;
    activeComparables: FeatureAccess;
    neighborhoodAnalysis: FeatureAccess;
    bidCeiling: FeatureAccess;
    advancedBidScenarios: FeatureAccess;
    dpeMap: FeatureAccess;
    lawyerDirectory: FeatureAccess;
    lawyerReferrals: FeatureAccess;
    audienceTracking: FeatureAccess;
    workspaceCollaboration: FeatureAccess;
  };
};

export type SavedPropertyReport = SavedReportRow & {
  plan: PlanEntitlements;
};

export type PropertyReportListResponse = {
  reports: SavedPropertyReport[];
  plan: PlanEntitlements;
};

export type PropertyReportSaveResponse = {
  report: SavedPropertyReport;
  plan: PlanEntitlements;
};

export type PropertyReportExport = {
  bytes: Uint8Array;
  filename: string;
  contentType: "application/pdf";
};

export type PropertyReportShare = {
  enabled: boolean;
  token: string | null;
  url: string | null;
  sharedAt: string | null;
  expiresAt: string | null;
  viewCount: number;
};

export type PropertyReportShareResponse = {
  report: SavedPropertyReport;
  plan: PlanEntitlements;
  share: PropertyReportShare;
};

export type PublicSharedPropertyReport = {
  id: string;
  title: string;
  reportKind: SavedReportRow["report_kind"];
  updatedAt: string;
  sharedAt: string | null;
  expiresAt: string | null;
  viewCount: number;
  plan: string | null;
  sale: Record<string, unknown>;
  analysis: Record<string, unknown>;
  market: Json;
  environmental: Json | null;
  ceiling: Json;
  sourceTrace: SourceTraceEntry[];
  limitations: string[];
  disclaimer: string;
};

export async function listPropertyReports({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId?: string | null;
}): Promise<PropertyReportListResponse> {
  const plan = await resolvePlanEntitlements(auth);
  let query = auth.supabase
    .from("saved_property_reports")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false });

  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error } = await query.limit(50);
  if (error) throw error;

  return {
    reports: (data ?? []).map((report) => attachPlan(report, plan)),
    plan,
  };
}

export async function savePropertyReport({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: PropertyReportRequestPayload;
}): Promise<PropertyReportSaveResponse> {
  const plan = await resolvePlanEntitlements(auth);
  const existingReportId = await getExistingReportId(
    auth.supabase,
    auth.userId,
    input.saleId,
    input.reportKind,
  );
  if (!existingReportId) await assertReportCreationAvailable(auth, plan);

  const sale = await getSale(auth.supabase, input.saleId);
  const marketEstimatePromise = buildMarketSnapshot(sale);
  const environmentalContextPromise =
    input.includeEnvironment && featureUnlocked(plan.features.neighborhoodAnalysis)
      ? getEnvironmentalContext({
          address: saleLocation(sale),
          lat: sale.latitude,
          lng: sale.longitude,
        })
      : Promise.resolve(null);
  const activeComparablesPromise = featureUnlocked(plan.features.activeComparables)
    ? getActiveComparableSales(auth.supabase, sale)
    : Promise.resolve(emptyActiveComparableSales());
  const cadastreParcelsPromise = getCadastralParcels(sale.source_url);
  const dpeDiagnosticsPromise = getDpeDiagnostics(sale.source_url);
  const urbanPlanningSignalsPromise = featureUnlocked(plan.features.urbanPlanning)
    ? getUrbanPlanningSignals(sale.source_url)
    : Promise.resolve([]);
  const valuationBacktestPromise = featureUnlocked(plan.features.soldComparables)
    ? getValuationBacktestForReport(sale)
    : Promise.resolve(null);
  const [
    marketEstimate,
    environmentalContext,
    activeComparables,
    cadastreParcels,
    dpeDiagnostics,
    urbanPlanningSignals,
    valuationBacktest,
  ] = await Promise.all([
    marketEstimatePromise,
    environmentalContextPromise,
    activeComparablesPromise,
    cadastreParcelsPromise,
    dpeDiagnosticsPromise,
    urbanPlanningSignalsPromise,
    valuationBacktestPromise,
  ]);
  const ceilingSnapshot = buildCeilingSnapshot(sale, marketEstimate);
  const reportSnapshot = buildReportSnapshot({
    sale,
    marketEstimate,
    environmentalContext: environmentalContext?.context ?? null,
    activeComparables,
    cadastreParcels,
    dpeDiagnostics,
    urbanPlanningSignals,
    valuationBacktest,
    ceilingSnapshot,
    plan,
  });
  const title = input.title?.trim() || defaultReportTitle(sale);

  const { data, error } = await auth.supabase
    .from("saved_property_reports")
    .upsert(
      {
        user_id: auth.userId,
        sale_id: input.saleId,
        report_kind: input.reportKind,
        title,
        user_notes: emptyToNull(input.userNotes),
        report_snapshot: asJson(reportSnapshot),
        market_snapshot: asJson(marketEstimate),
        environmental_snapshot: environmentalContext ? asJson(environmentalContext.context) : null,
        ceiling_snapshot: asJson(ceilingSnapshot),
      },
      { onConflict: "user_id,sale_id,report_kind" },
    )
    .select("*")
    .single();

  if (error) throw error;

  if (!existingReportId) {
    await recordFeatureUsageEvent({
      auth,
      eventKey: "property_report.created",
      subjectType: "saved_property_report",
      subjectId: data.id,
      metadata: {
        sale_id: input.saleId,
        report_kind: input.reportKind,
        plan: plan.plan,
      },
    });
  }

  return {
    report: attachPlan(data, plan),
    plan,
  };
}

export async function updatePropertyReport({
  auth,
  reportId,
  input,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
  input: PropertyReportUpdatePayload;
}): Promise<PropertyReportSaveResponse> {
  const plan = await resolvePlanEntitlements(auth);
  const patch: Database["public"]["Tables"]["saved_property_reports"]["Update"] = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.userNotes !== undefined) patch.user_notes = emptyToNull(input.userNotes ?? undefined);

  const { data, error } = await auth.supabase
    .from("saved_property_reports")
    .update(patch)
    .eq("id", reportId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;

  return {
    report: attachPlan(data, plan),
    plan,
  };
}

export async function deletePropertyReport({
  auth,
  reportId,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
}): Promise<{ ok: true }> {
  const { error } = await auth.supabase
    .from("saved_property_reports")
    .delete()
    .eq("id", reportId)
    .eq("user_id", auth.userId);
  if (error) throw error;
  return { ok: true };
}

export async function exportPropertyReportPdf({
  auth,
  reportId,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
}): Promise<PropertyReportExport> {
  const plan = await resolvePlanEntitlements(auth);
  await assertPdfExportAvailable(auth, plan);
  const report = await getReport(auth.supabase, auth.userId, reportId);
  const lines = reportToPdfLines(report, plan);
  const bytes = createTextPdf({
    title: report.title,
    lines,
    footer:
      "ImmoJudis - rapport indicatif. Verifiez les pieces officielles et votre conseil avant toute enchere.",
    watermark: pdfWatermarkForPlan(plan),
  });

  await recordPdfExport(auth, report);

  return {
    bytes,
    filename: `${slugify(report.title)}-${report.id.slice(0, 8)}.pdf`,
    contentType: "application/pdf",
  };
}

export async function enablePropertyReportShare({
  auth,
  reportId,
  origin,
  expiresAt,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
  origin?: string | null;
  expiresAt?: string | null;
}): Promise<PropertyReportShareResponse> {
  const plan = await resolvePlanEntitlements(auth);
  const report = await getReport(auth.supabase, auth.userId, reportId);
  const shareToken = report.share_token || createShareToken();
  const shareExpiresAt = normalizeShareExpiresAt(expiresAt);
  const now = new Date().toISOString();

  const { data, error } = await auth.supabase
    .from("saved_property_reports")
    .update({
      share_enabled: true,
      share_token: shareToken,
      shared_at: now,
      share_expires_at: shareExpiresAt,
    })
    .eq("id", reportId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;

  return {
    report: attachPlan(data, plan),
    plan,
    share: buildPropertyReportShare(data, origin),
  };
}

export async function disablePropertyReportShare({
  auth,
  reportId,
  origin,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
  origin?: string | null;
}): Promise<PropertyReportShareResponse> {
  const plan = await resolvePlanEntitlements(auth);

  const { data, error } = await auth.supabase
    .from("saved_property_reports")
    .update({
      share_enabled: false,
      share_expires_at: null,
    })
    .eq("id", reportId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;

  return {
    report: attachPlan(data, plan),
    plan,
    share: buildPropertyReportShare(data, origin),
  };
}

export async function getSharedPropertyReport({
  token,
  countView = true,
}: {
  token: string;
  countView?: boolean;
}): Promise<PublicSharedPropertyReport> {
  const normalized = normalizeShareToken(token);
  if (!normalized) throw new Error("Lien de partage invalide.");

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .select(
      "id,title,report_kind,report_snapshot,market_snapshot,environmental_snapshot,ceiling_snapshot,share_enabled,share_token,shared_at,share_expires_at,share_view_count,updated_at",
    )
    .eq("share_token", normalized)
    .eq("share_enabled", true)
    .maybeSingle();

  if (error) throw error;
  if (!data || shareIsExpired(data.share_expires_at)) {
    throw new Error("Rapport partagé introuvable ou expiré.");
  }

  if (countView) {
    const nextViewCount = data.share_view_count + 1;
    const { error: updateError } = await supabaseAdmin
      .from("saved_property_reports")
      .update({ share_view_count: nextViewCount })
      .eq("id", data.id);
    if (!updateError) data.share_view_count = nextViewCount;
  }

  return buildPublicSharedPropertyReport(data);
}

export function buildPropertyReportShare(
  report: Pick<
    SavedReportRow,
    "share_enabled" | "share_token" | "shared_at" | "share_expires_at" | "share_view_count"
  >,
  origin?: string | null,
): PropertyReportShare {
  const token = report.share_token;
  const enabled = Boolean(
    report.share_enabled && token && !shareIsExpired(report.share_expires_at),
  );

  return {
    enabled,
    token: enabled ? token : null,
    url: enabled && token && origin ? new URL(`/reports/shared/${token}`, origin).toString() : null,
    sharedAt: report.shared_at,
    expiresAt: report.share_expires_at,
    viewCount: report.share_view_count,
  };
}

export function buildPublicSharedPropertyReport(
  report: Pick<
    SavedReportRow,
    | "id"
    | "title"
    | "report_kind"
    | "report_snapshot"
    | "market_snapshot"
    | "environmental_snapshot"
    | "ceiling_snapshot"
    | "shared_at"
    | "share_expires_at"
    | "share_view_count"
    | "updated_at"
  >,
): PublicSharedPropertyReport {
  const rawSnapshot = asRecord(report.report_snapshot);
  const snapshot = sanitizeReportSnapshotForPlan(
    rawSnapshot,
    buildPlanEntitlements(normalizePlanCode(rawSnapshot.plan)),
  );
  const traceability = asRecord(snapshot.sourceTraceability);

  return {
    id: report.id,
    title: report.title,
    reportKind: report.report_kind,
    updatedAt: report.updated_at,
    sharedAt: report.shared_at,
    expiresAt: report.share_expires_at,
    viewCount: report.share_view_count,
    plan: typeof snapshot.plan === "string" ? snapshot.plan : null,
    sale: asRecord(snapshot.sale),
    analysis: asRecord(snapshot.analysis),
    market: report.market_snapshot,
    environmental: report.environmental_snapshot,
    ceiling: report.ceiling_snapshot,
    sourceTrace: normalizeSourceTrace(traceability.entries),
    limitations: normalizeStringList(traceability.limitations),
    disclaimer: stringValue(traceability.complianceNotice, REPORT_COMPLIANCE_NOTICE),
  };
}

export async function resolvePlanEntitlements(
  auth: SupabaseAuthContext,
): Promise<PlanEntitlements> {
  if (hasAdminRole(auth.claims)) return buildPlanEntitlements("investisseur");

  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select("plan_code,status")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  const plan =
    data && isActivePlanStatus(data.status) ? normalizePlanCode(data.plan_code) : "decouverte";
  return buildPlanEntitlements(plan);
}

function buildPlanEntitlements(plan: PlanCode): PlanEntitlements {
  return {
    plan,
    label: PLAN_LABELS[plan],
    limits: PLAN_LIMITS[plan],
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

function featureUnlocked(access: FeatureAccess): boolean {
  return access !== "locked";
}

function emptyActiveComparableSales(): ActiveComparableSales {
  return {
    scopeLabel: "Réservé au plan Analyse",
    sales: [],
  };
}

function sanitizeReportSnapshotForPlan(
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

function gateMarketComparablesAnalysis<T extends object>(analysis: T, plan: PlanEntitlements): T {
  return {
    ...analysis,
    ...(!featureUnlocked(plan.features.soldComparables) ? { retainedComparables: [] } : {}),
    ...(!featureUnlocked(plan.features.saleHistory) ? { addressHistory: [] } : {}),
  } as T;
}

function lockedUrbanPlanningAnalysis(): ReturnType<typeof buildUrbanPlanningAnalysis> {
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

function lockedStreetFacadeAnalysis(): ReturnType<typeof buildStreetFacadeAnalysis> {
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

function lockedNeighborhoodAnalysis(): ReturnType<typeof buildNeighborhoodAnalysis> {
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

function lockedActiveComparablesAnalysis(): ReturnType<typeof buildActiveComparablesAnalysis> {
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

async function assertPdfExportAvailable(auth: SupabaseAuthContext, plan: PlanEntitlements) {
  await assertUsageLimitAvailable({
    auth,
    eventKey: "property_report.pdf_exported",
    limit: plan.limits.pdfExportsPerMonth,
    label: "PDF",
    planLabel: plan.label,
  });
}

async function assertReportCreationAvailable(auth: SupabaseAuthContext, plan: PlanEntitlements) {
  await assertUsageLimitAvailable({
    auth,
    eventKey: "property_report.created",
    limit: plan.limits.propertyReportsPerMonth,
    label: "rapports mensuels",
    planLabel: plan.label,
  });
}

async function getSale(supabase: SupabaseClient, saleId: string): Promise<AuctionSale> {
  const { data, error } = await supabase
    .from("v_auction_sales_app")
    .select("*")
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("Vente introuvable ou inaccessible.");

  return appSaleRowToAuctionSale(data);
}

type ActiveComparableScope = {
  label: string;
  city?: string | null;
  department?: string | null;
  tribunalCode?: string | null;
  propertyType?: string | null;
};

async function getActiveComparableSales(
  supabase: SupabaseClient,
  sale: AuctionSale,
): Promise<ActiveComparableSales> {
  const scopes = buildActiveComparableScopes(sale);
  const byId = new Map<string, AuctionSale>();
  const usedLabels: string[] = [];
  const nowIso = new Date().toISOString();

  for (const scope of scopes) {
    const rows = await queryActiveComparableSales({
      supabase,
      sale,
      scope,
      nowIso,
      limit: 8,
    });
    if (rows.length) usedLabels.push(scope.label);
    for (const row of rows) {
      const comparable = appSaleRowToAuctionSale(row);
      if (comparable.id && comparable.id !== sale.id && !byId.has(comparable.id)) {
        byId.set(comparable.id, comparable);
      }
    }
    if (byId.size >= 8) break;
  }

  return {
    scopeLabel: usedLabels.length
      ? usedLabels.length === 1
        ? usedLabels[0]
        : `Périmètre élargi : ${usedLabels.slice(0, 3).join(" · ")}`
      : "Aucun périmètre actif trouvé",
    sales: [...byId.values()].slice(0, 12),
  };
}

async function getCadastralParcels(
  sourceUrl: string | null | undefined,
): Promise<StructuredCadastralParcel[]> {
  if (!sourceUrl) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_cadastre_parcels")
    .select("*")
    .eq("source_url", sourceUrl)
    .order("confidence", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(8);

  if (error) {
    console.warn("Unable to load cadastral parcels for report", {
      sourceUrl,
      message: error.message,
    });
    return [];
  }

  return (data ?? []).map(cadastreParcelRowToAnalysis);
}

function cadastreParcelRowToAnalysis(row: CadastreParcelRow): StructuredCadastralParcel {
  return {
    parcelKey: row.parcel_key ?? null,
    parcelId: row.parcel_id ?? null,
    codeInsee: row.code_insee ?? null,
    department: row.department ?? null,
    city: row.city ?? null,
    section: row.section ?? null,
    parcelNumber: row.parcel_number ?? null,
    surfaceM2: row.surface_m2 ?? null,
    centroidLat: row.centroid_lat ?? null,
    centroidLng: row.centroid_lng ?? null,
    matchKind: row.match_kind ?? null,
    confidence: row.confidence ?? null,
    sourceApi: row.source_api ?? null,
  };
}

async function getDpeDiagnostics(
  sourceUrl: string | null | undefined,
): Promise<StructuredDpeDiagnostic[]> {
  if (!sourceUrl) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_dpe_diagnostics")
    .select("*")
    .eq("source_url", sourceUrl)
    .order("confidence", { ascending: false })
    .order("established_at", { ascending: false, nullsFirst: false })
    .limit(8);

  if (error) {
    console.warn("Unable to load DPE diagnostics for report", {
      sourceUrl,
      message: error.message,
    });
    return [];
  }

  return (data ?? []).map(dpeDiagnosticRowToAnalysis);
}

function dpeDiagnosticRowToAnalysis(row: DpeDiagnosticRow): StructuredDpeDiagnostic {
  return {
    diagnosticNumber: row.diagnostic_number ?? null,
    dpeClass: normalizeDpeClass(row.dpe_class),
    gesClass: normalizeDpeClass(row.ges_class),
    establishedAt: row.established_at ?? null,
    validUntil: row.valid_until ?? null,
    propertyType: row.property_type ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    inseeCode: row.insee_code ?? null,
    department: row.department ?? null,
    surfaceM2: row.surface_m2 ?? null,
    energyConsumptionKwhM2Year: row.energy_consumption_kwh_m2_year ?? null,
    emissionsKgCo2M2Year: row.emissions_kg_co2_m2_year ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    matchKind: row.match_kind ?? null,
    confidence: row.confidence ?? null,
    sourceApi: row.source_api ?? null,
  };
}

async function getUrbanPlanningSignals(
  sourceUrl: string | null | undefined,
): Promise<StructuredUrbanPlanningSignal[]> {
  if (!sourceUrl) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_urban_planning_signals")
    .select("*")
    .eq("source_url", sourceUrl)
    .order("confidence", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(16);

  if (error) {
    console.warn("Unable to load urban planning signals for report", {
      sourceUrl,
      message: error.message,
    });
    return [];
  }

  return (data ?? []).map(urbanPlanningSignalRowToAnalysis);
}

function urbanPlanningSignalRowToAnalysis(
  row: UrbanPlanningSignalRow,
): StructuredUrbanPlanningSignal {
  return {
    signalKey: row.signal_key,
    signalKind: normalizeUrbanPlanningSignalKind(row.signal_kind),
    label: row.label ?? null,
    status: row.status === "documented" ? "documented" : "to_verify",
    priority: normalizeUrbanPlanningPriority(row.priority),
    sourceName: row.source_name ?? null,
    sourceKind: row.source_kind ?? null,
    documentUrl: row.document_url ?? null,
    documentLabel: row.document_label ?? null,
    documentType: row.document_type ?? null,
    pageNumber: row.page_number ?? null,
    excerpt: row.excerpt ?? null,
    action: row.action ?? null,
    confidence: row.confidence ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function normalizeUrbanPlanningSignalKind(
  value: string,
): StructuredUrbanPlanningSignal["signalKind"] {
  if (
    value === "zoning" ||
    value === "permit" ||
    value === "servitude" ||
    value === "coownership" ||
    value === "usage" ||
    value === "public_record"
  ) {
    return value;
  }
  return "public_record";
}

function normalizeUrbanPlanningPriority(value: string): StructuredUrbanPlanningSignal["priority"] {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

async function getValuationBacktestForReport(
  sale: AuctionSale,
): Promise<ValuationBacktestResult | null> {
  try {
    return await buildValuationBacktestForSale({
      sale: {
        department: sale.department ?? null,
        propertyType: sale.property_type ?? null,
        surfaceM2: getSaleSurface(sale).value,
        latitude: sale.latitude ?? null,
        longitude: sale.longitude ?? null,
      },
    });
  } catch (error) {
    console.warn("Unable to build valuation backtest for report", {
      sourceUrl: sale.source_url,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function buildActiveComparableScopes(sale: AuctionSale): ActiveComparableScope[] {
  const scopes: ActiveComparableScope[] = [];
  if (sale.city && sale.department) {
    scopes.push({
      label: "Même ville et même type de bien",
      city: sale.city,
      department: sale.department,
      propertyType: sale.property_type,
    });
  }
  if (sale.tribunal_code) {
    scopes.push({
      label: "Même tribunal et même type de bien",
      tribunalCode: sale.tribunal_code,
      propertyType: sale.property_type,
    });
  }
  if (sale.department) {
    scopes.push({
      label: "Même département et même type de bien",
      department: sale.department,
      propertyType: sale.property_type,
    });
    scopes.push({
      label: "Même département",
      department: sale.department,
    });
  }
  if (sale.city) {
    scopes.push({
      label: "Même ville",
      city: sale.city,
    });
  }
  if (sale.property_type) {
    scopes.push({
      label: "Même type de bien",
      propertyType: sale.property_type,
    });
  }
  return uniqueActiveComparableScopes(scopes);
}

async function queryActiveComparableSales({
  supabase,
  sale,
  scope,
  nowIso,
  limit,
}: {
  supabase: SupabaseClient;
  sale: AuctionSale;
  scope: ActiveComparableScope;
  nowIso: string;
  limit: number;
}): Promise<AppSaleRow[]> {
  let query = supabase
    .from("v_auction_sales_app")
    .select("*")
    .not("id", "is", null)
    .not("sale_date", "is", null)
    .gte("sale_date", nowIso)
    .order("sale_date", { ascending: true })
    .limit(limit);

  if (sale.id) query = query.neq("id", sale.id);
  if (scope.city) query = query.eq("city", scope.city);
  if (scope.department) query = query.eq("department", scope.department);
  if (scope.tribunalCode) query = query.eq("tribunal_code", scope.tribunalCode);
  if (scope.propertyType) query = query.eq("property_type", scope.propertyType);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AppSaleRow[];
}

function uniqueActiveComparableScopes(scopes: ActiveComparableScope[]): ActiveComparableScope[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = [scope.city, scope.department, scope.tribunalCode, scope.propertyType]
      .map((value) => value ?? "")
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getReport(
  supabase: SupabaseClient,
  userId: string,
  reportId: string,
): Promise<SavedReportRow> {
  const { data, error } = await supabase
    .from("saved_property_reports")
    .select("*")
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Rapport introuvable.");
  return data;
}

async function getExistingReportId(
  supabase: SupabaseClient,
  userId: string,
  saleId: string,
  reportKind: SavedReportRow["report_kind"],
): Promise<string | null> {
  const { data, error } = await supabase
    .from("saved_property_reports")
    .select("id")
    .eq("user_id", userId)
    .eq("sale_id", saleId)
    .eq("report_kind", reportKind)
    .maybeSingle();

  if (error) throw error;
  return data?.id ?? null;
}

async function recordPdfExport(auth: SupabaseAuthContext, report: SavedReportRow) {
  const now = new Date().toISOString();
  const { error: insertError } = await auth.supabase.from("property_report_exports").insert({
    report_id: report.id,
    user_id: auth.userId,
    export_format: "pdf",
  });
  if (insertError) throw insertError;

  const { error: updateError } = await auth.supabase
    .from("saved_property_reports")
    .update({
      export_count: report.export_count + 1,
      last_exported_at: now,
    })
    .eq("id", report.id)
    .eq("user_id", auth.userId);
  if (updateError) throw updateError;

  await recordFeatureUsageEvent({
    auth,
    eventKey: "property_report.pdf_exported",
    subjectType: "saved_property_report",
    subjectId: report.id,
    metadata: {
      export_format: "pdf",
      sale_id: report.sale_id,
    },
  });
}

async function buildMarketSnapshot(sale: AuctionSale): Promise<MarketEstimate | null> {
  const surface = getSaleSurface(sale).value;
  if (sale.latitude == null || sale.longitude == null || surface == null || surface <= 0) {
    return null;
  }

  const response = await getMarketEstimate({
    lat: sale.latitude,
    lng: sale.longitude,
    propertyType: sale.property_type,
    surfaceM2: surface,
  });

  return response.estimate;
}

function buildCeilingSnapshot(sale: AuctionSale, marketEstimate: MarketEstimate | null) {
  const surface = getSaleSurface(sale).value;
  const scenario = "equilibre";
  const ceiling = computeMarketCeiling({
    surface,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    works: DEFAULTS.works,
    fpt: DEFAULTS.fpt,
    scenario,
    medianPricePerM2: marketEstimate?.medianPricePerM2,
    p25PricePerM2: marketEstimate?.p25PricePerM2,
    p75PricePerM2: marketEstimate?.p75PricePerM2,
  });
  const acquisition = computeAcquisitionCosts({
    price: Math.max(0, sale.starting_price_eur ?? 0),
    works: DEFAULTS.works,
    fpt: DEFAULTS.fpt,
  });

  return {
    scenario,
    available: ceiling.available,
    reason: ceiling.reason ?? null,
    maxBid: ceiling.available ? ceiling.maxBid : null,
    targetTotalCost: ceiling.available ? ceiling.targetTotalCost : null,
    marketReferencePricePerM2: ceiling.available ? ceiling.marketReferencePricePerM2 : null,
    safetyDiscountPct: ceiling.available ? ceiling.safetyDiscountPct : null,
    marginTotal: ceiling.available ? ceiling.marginTotal : null,
    marginPerM2: ceiling.available ? ceiling.marginPerM2 : null,
    acquisition,
  };
}

export function buildOpportunityAnalysis({
  sale,
  surfaceM2,
  marketEstimate,
  ceilingSnapshot,
}: {
  sale: AuctionSale;
  surfaceM2: number | null;
  marketEstimate: MarketEstimate | null;
  ceilingSnapshot: ReturnType<typeof buildCeilingSnapshot>;
}) {
  const startingPrice = positiveNumber(sale.starting_price_eur);
  const surface = positiveNumber(surfaceM2);
  const startingPricePerM2 = roundedNumber(pricePerM2(startingPrice, surface));
  const medianPricePerM2 = positiveNumber(marketEstimate?.medianPricePerM2);
  const p25PricePerM2 = positiveNumber(marketEstimate?.p25PricePerM2);
  const p75PricePerM2 = positiveNumber(marketEstimate?.p75PricePerM2);
  const estimatedMarketValue =
    surface && medianPricePerM2 ? Math.round(surface * medianPricePerM2) : null;
  const estimatedMarketLow = surface && p25PricePerM2 ? Math.round(surface * p25PricePerM2) : null;
  const estimatedMarketHigh = surface && p75PricePerM2 ? Math.round(surface * p75PricePerM2) : null;
  const apparentDiscountPct =
    startingPrice && estimatedMarketValue
      ? roundPercent(((estimatedMarketValue - startingPrice) / estimatedMarketValue) * 100)
      : null;
  const grossYieldPct = roundPercent(
    estimateGrossYieldPct(startingPrice, surface, sale.department),
  );
  const score =
    roundedNumber(sale.investment_score) ??
    deriveOpportunityScore({
      apparentDiscountPct,
      grossYieldPct,
      ceilingSnapshot,
    });
  const scoreConfidence = roundPercent(
    typeof sale.score_confidence === "number" ? sale.score_confidence * 100 : null,
  );
  const acquisition = ceilingSnapshot.acquisition;
  const totalCostPerM2 = surface ? roundedNumber(acquisition.totalCost / surface) : null;
  const rentabilityScore = computeRentabilityScore({
    surface,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    works: DEFAULTS.works,
    fpt: DEFAULTS.fpt,
    department: sale.department,
    marketMarginPerM2: ceilingSnapshot.available ? ceilingSnapshot.marginPerM2 : null,
  });

  return {
    score,
    scoreConfidencePct: scoreConfidence,
    label: opportunityScoreLabel(score),
    summary: opportunitySummary({
      apparentDiscountPct,
      grossYieldPct,
      score,
      ceilingAvailable: ceilingSnapshot.available,
    }),
    startingPricePerM2,
    estimatedMarketValue,
    estimatedMarketLow,
    estimatedMarketHigh,
    apparentDiscountPct,
    grossYieldPct,
    rentabilityScore,
    acquisitionCosts: {
      acquisitionFeesTotal: Math.round(acquisition.acquisitionFeesTotal),
      acquisitionFeesPct: roundPercent(acquisition.acquisitionFeesPct),
      totalCost: Math.round(acquisition.totalCost),
      totalCostPerM2,
      fpt: Math.round(acquisition.fpt),
      works: Math.round(acquisition.works),
    },
    bidCeiling: {
      available: ceilingSnapshot.available,
      maxBid: ceilingSnapshot.available ? ceilingSnapshot.maxBid : null,
      targetTotalCost: ceilingSnapshot.available ? ceilingSnapshot.targetTotalCost : null,
      marginTotal: ceilingSnapshot.available ? ceilingSnapshot.marginTotal : null,
      marginPerM2: ceilingSnapshot.available ? ceilingSnapshot.marginPerM2 : null,
    },
    scoreFactors: normalizeScoreFactors(sale.score_factors).slice(0, 5),
  };
}

function buildReportSnapshot({
  sale,
  marketEstimate,
  environmentalContext,
  activeComparables,
  cadastreParcels,
  dpeDiagnostics,
  urbanPlanningSignals,
  valuationBacktest,
  ceilingSnapshot,
  plan,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  environmentalContext?: EnvironmentalContext | null;
  activeComparables: ActiveComparableSales;
  cadastreParcels: StructuredCadastralParcel[];
  dpeDiagnostics: StructuredDpeDiagnostic[];
  urbanPlanningSignals: StructuredUrbanPlanningSignal[];
  valuationBacktest: ValuationBacktestResult | null;
  ceilingSnapshot: ReturnType<typeof buildCeilingSnapshot>;
  plan: PlanEntitlements;
}) {
  const generatedAt = new Date().toISOString();
  const surface = getSaleSurface(sale);
  const risks = normalizeRisks(sale.risks).slice(0, 8);
  const documents = Array.isArray(sale.documents_rich) ? sale.documents_rich : [];
  const marketComparablesAnalysis = gateMarketComparablesAnalysis(
    buildMarketComparablesAnalysis(marketEstimate),
    plan,
  );
  const valuationAudit = buildValuationAudit({
    sale,
    surfaceM2: surface.value,
    marketEstimate,
  });
  const sourceTraceability = buildReportTraceability({
    sale,
    marketEstimate,
    cadastreParcels,
    dpeDiagnostics,
    urbanPlanningSignals,
    environmentalContext,
    generatedAt,
  });
  const dpeClass = dpeFromSourceBlocks(sale.source_blocks);
  const dpeAnalysis = buildDpeAnalysis(sale, dpeDiagnostics);
  const cadastralAnalysis = buildCadastralAnalysis(sale, cadastreParcels);
  const nearbyServices = buildNearbyServicesAnalysis(sale);
  const demographicAnalysis = buildDemographicAnalysis({
    sale,
    marketEstimate,
    nearbyServices,
  });
  const occupancyAnalysis = buildOccupancyAnalysis(sale);
  const renovationAnalysis = buildRenovationAnalysis({ sale, surfaceM2: surface.value });
  const streetFacadeAnalysis = featureUnlocked(plan.features.streetFacade)
    ? buildStreetFacadeAnalysis(sale)
    : lockedStreetFacadeAnalysis();
  const neighborhoodAnalysis = featureUnlocked(plan.features.neighborhoodAnalysis)
    ? buildNeighborhoodAnalysis({
        sale,
        marketEstimate,
        nearbyServices,
        streetFacade: streetFacadeAnalysis,
        environmentalContext,
      })
    : lockedNeighborhoodAnalysis();
  const activeComparablesAnalysis = featureUnlocked(plan.features.activeComparables)
    ? buildActiveComparablesAnalysis({
        sale,
        candidates: activeComparables.sales,
        scopeLabel: activeComparables.scopeLabel,
      })
    : lockedActiveComparablesAnalysis();
  const auctionCostAnalysis = buildAuctionCostAnalysis({
    sale,
    acquisition: ceilingSnapshot.acquisition,
  });
  const urbanPlanningAnalysis = featureUnlocked(plan.features.urbanPlanning)
    ? buildUrbanPlanningAnalysis({
        sale,
        documents,
        risks: sale.risks ?? [],
        structuredSignals: urbanPlanningSignals,
      })
    : lockedUrbanPlanningAnalysis();
  const hasDiagnostics =
    Boolean(dpeClass) ||
    documents.some((doc) =>
      /diagnostic|dpe|amiante|plomb|termite/i.test(`${doc.type} ${doc.label}`),
    );
  const legalAttentionAnalysis = buildLegalAttentionAnalysis({
    sale,
    documents,
    risks: sale.risks ?? [],
    cadastralAnalysis,
    occupancyAnalysis,
    auctionCostAnalysis,
    hasDiagnostics,
  });
  const audienceReadinessAnalysis = buildAudienceReadinessAnalysis({
    sale,
    documents,
    auctionCostAnalysis,
    occupancyAnalysis,
    renovationAnalysis,
    legalAttentionAnalysis,
    bidCeilingAvailable: ceilingSnapshot.available,
    now: new Date(generatedAt),
  });

  return {
    generatedAt,
    plan: plan.plan,
    sourceTraceability,
    sale: {
      id: sale.id,
      title: cleanSaleTitle(sale.title),
      city: sale.city,
      department: sale.department,
      address: sale.address,
      propertyType: propertyTypeLabel(sale.property_type),
      startingPrice: sale.starting_price_eur,
      saleDate: sale.sale_date,
      tribunal: sale.tribunal ?? sale.tribunal_name,
      surface: surface.value,
      surfaceLabel: surface.label,
      occupancy: occupancyLabel(sale.occupancy_status),
    },
    analysis: {
      valueEstimate: marketEstimate?.medianPricePerM2
        ? {
            medianPricePerM2: marketEstimate.medianPricePerM2,
            p25PricePerM2: marketEstimate.p25PricePerM2,
            p75PricePerM2: marketEstimate.p75PricePerM2,
            sampleSize: marketEstimate.sampleSize,
            qualityLabel: marketEstimate.qualityLabel,
            radiusM: marketEstimate.radiusM,
          }
        : null,
      marketComparablesAnalysis,
      valuationAudit,
      valuationBacktest: featureUnlocked(plan.features.soldComparables) ? valuationBacktest : null,
      cadastralAnalysis,
      dpe: {
        ...dpeAnalysis,
        available: dpeAnalysis.available || hasDiagnostics,
        class: dpeAnalysis.class ?? dpeClass,
      },
      auctionCostAnalysis,
      demographicAnalysis,
      occupancyAnalysis,
      renovationAnalysis,
      urbanPlanningAnalysis,
      streetFacadeAnalysis,
      neighborhoodAnalysis,
      activeComparablesAnalysis,
      audienceReadinessAnalysis,
      nearbyServices,
      legalAttentionAnalysis,
      opportunity: buildOpportunityAnalysis({
        sale,
        surfaceM2: surface.value,
        marketEstimate,
        ceilingSnapshot,
      }),
      legalAttentionPoints: legalAttentionAnalysis.items
        .map((item) => `${item.label} : ${item.action}`)
        .slice(0, 8),
      risks,
      documentsCount: documents.length,
      sourceName: sale.source_name,
    },
    gatedFeatures: plan.features,
  };
}

function reportToPdfLines(report: SavedReportRow, plan: PlanEntitlements): string[] {
  const snapshot = sanitizeReportSnapshotForPlan(asRecord(report.report_snapshot), plan);
  const traceability = asRecord(snapshot.sourceTraceability);
  const sourceTrace = normalizeSourceTrace(traceability.entries);
  const limitations = normalizeStringList(traceability.limitations);
  const complianceNotice = stringValue(traceability.complianceNotice, REPORT_COMPLIANCE_NOTICE);
  const market = asRecord(report.market_snapshot);
  const ceiling = asRecord(report.ceiling_snapshot);
  const sale = asRecord(snapshot.sale);
  const analysis = asRecord(snapshot.analysis);
  const valueEstimate = asRecord(analysis.valueEstimate);
  const marketComparables = asRecord(analysis.marketComparablesAnalysis);
  const retainedComparables = normalizeMarketComparableRows(marketComparables.retainedComparables);
  const addressHistory = normalizeMarketComparableRows(marketComparables.addressHistory);
  const marketComparablesActions = normalizeStringList(marketComparables.nextActions);
  const valuationAudit = asRecord(analysis.valuationAudit);
  const valuationBacktest = asRecord(analysis.valuationBacktest);
  const valuationBacktestSummary = asRecord(valuationBacktest.summary);
  const valuationBacktestActions = normalizeStringList(valuationBacktest.nextActions);
  const valuationCheckpoints = normalizeValuationCheckpoints(valuationAudit.checkpoints);
  const valuationActions = normalizeStringList(valuationAudit.nextActions);
  const valuationRiskFlags = normalizeStringList(valuationAudit.riskFlags);
  const opportunity = asRecord(analysis.opportunity);
  const rentabilityScore = asRecord(opportunity.rentabilityScore);
  const acquisitionCosts = asRecord(opportunity.acquisitionCosts);
  const legalAttentionPoints = Array.isArray(analysis.legalAttentionPoints)
    ? analysis.legalAttentionPoints
    : [];
  const cadastral = asRecord(analysis.cadastralAnalysis);
  const cadastralReferences = normalizeCadastralReferences(cadastral.references);
  const cadastralNextActions = normalizeStringList(cadastral.nextActions);
  const nearbyServices = asRecord(analysis.nearbyServices);
  const nearbyCategories = normalizeNearbyCategoryLabels(nearbyServices.categories);
  const nearbyNextActions = normalizeStringList(nearbyServices.nextActions);
  const demographicAnalysis = asRecord(analysis.demographicAnalysis);
  const demographicSignals = normalizeDemographicSignals(demographicAnalysis.signals);
  const demographicActions = normalizeStringList(demographicAnalysis.nextActions);
  const demographicMissingData = normalizeStringList(demographicAnalysis.missingData);
  const occupancyAnalysis = asRecord(analysis.occupancyAnalysis);
  const occupancyEvidence = normalizeOccupancyEvidence(occupancyAnalysis.evidence);
  const occupancyNextActions = normalizeStringList(occupancyAnalysis.nextActions);
  const auctionCostAnalysis = asRecord(analysis.auctionCostAnalysis);
  const auctionCostSignals = normalizeStringList(auctionCostAnalysis.sourceFeeSignals);
  const auctionCostActions = normalizeStringList(auctionCostAnalysis.nextActions);
  const consignation = asRecord(auctionCostAnalysis.consignation);
  const legalAttentionAnalysis = asRecord(analysis.legalAttentionAnalysis);
  const legalAttentionItems = normalizeLegalAttentionItems(legalAttentionAnalysis.items);
  const legalAttentionActions = normalizeStringList(legalAttentionAnalysis.nextActions);
  const urbanPlanningAnalysis = asRecord(analysis.urbanPlanningAnalysis);
  const urbanPlanningItems = normalizeUrbanPlanningItems(urbanPlanningAnalysis.items);
  const urbanPlanningActions = normalizeStringList(urbanPlanningAnalysis.nextActions);
  const urbanPlanningMissingChecks = normalizeStringList(urbanPlanningAnalysis.missingChecks);
  const dpe = asRecord(analysis.dpe);
  const dpeDiagnostic = asRecord(dpe.diagnostic);
  const dpeEvidence = normalizeDpeEvidence(dpe.evidence);
  const dpeNextActions = normalizeStringList(dpe.nextActions);
  const renovationAnalysis = asRecord(analysis.renovationAnalysis);
  const renovationEvidence = normalizeRenovationEvidence(renovationAnalysis.evidence);
  const renovationActions = normalizeStringList(renovationAnalysis.nextActions);
  const renovationBudgetRange = formatRenovationBudgetRange(
    asRecord(renovationAnalysis.budgetRange),
  );
  const streetFacadeAnalysis = asRecord(analysis.streetFacadeAnalysis);
  const streetFacadeActions = normalizeStringList(streetFacadeAnalysis.nextActions);
  const streetFacadeLimitations = normalizeStringList(streetFacadeAnalysis.limitations);
  const neighborhoodAnalysis = asRecord(analysis.neighborhoodAnalysis);
  const neighborhoodSignals = normalizeNeighborhoodSignals(neighborhoodAnalysis.signals);
  const neighborhoodActions = normalizeStringList(neighborhoodAnalysis.nextActions);
  const activeComparablesAnalysis = asRecord(analysis.activeComparablesAnalysis);
  const activeComparableItems = normalizeActiveComparableItems(activeComparablesAnalysis.items);
  const activeComparableActions = normalizeStringList(activeComparablesAnalysis.nextActions);
  const audienceReadinessAnalysis = asRecord(analysis.audienceReadinessAnalysis);
  const audienceChecklistItems = normalizeAudienceChecklistItems(
    audienceReadinessAnalysis.checklist,
  );
  const audienceReadinessActions = normalizeStringList(audienceReadinessAnalysis.nextActions);
  const canShowSoldComparables = featureUnlocked(plan.features.soldComparables);
  const canShowSaleHistory = featureUnlocked(plan.features.saleHistory);
  const canShowUrbanPlanning = featureUnlocked(plan.features.urbanPlanning);
  const canShowStreetFacade = featureUnlocked(plan.features.streetFacade);
  const canShowNeighborhood = featureUnlocked(plan.features.neighborhoodAnalysis);
  const canShowActiveComparables = featureUnlocked(plan.features.activeComparables);

  return [
    `Plan: ${plan.label}`,
    `Genere le: ${formatDate(String(snapshot.generatedAt ?? report.updated_at))}`,
    "",
    "Bien",
    `Titre: ${stringValue(cleanSaleTitle(stringValue(sale.title, null)), report.title)}`,
    `Localisation: ${[sale.address, sale.city, sale.department].filter(Boolean).join(", ") || "a confirmer"}`,
    `Type: ${stringValue(sale.propertyType, "Bien")}`,
    `Surface retenue: ${stringValue(sale.surfaceLabel, "a confirmer")}`,
    `Occupation: ${stringValue(
      occupancyAnalysis.summary,
      stringValue(sale.occupancy, "a verifier"),
    )}`,
    `Confiance occupation: ${stringValue(occupancyAnalysis.confidenceLabel, "a confirmer")}`,
    `Impact occupation: ${stringValue(occupancyAnalysis.decisionImpact, "a verifier avant enchere")}`,
    `Tribunal: ${stringValue(sale.tribunal, "a confirmer")}`,
    `Audience: ${formatDate(stringValue(sale.saleDate, null))}`,
    `Preparation audience: ${stringValue(audienceReadinessAnalysis.summary, "a completer")}`,
    `Urgence audience: ${stringValue(audienceReadinessAnalysis.urgencyLabel, "date a confirmer")}`,
    `Mise a prix: ${formatPrice(numberValue(sale.startingPrice))}`,
    "",
    "Estimation marche",
    valueEstimate.medianPricePerM2
      ? `Reference mediane: ${formatPricePerM2(numberValue(valueEstimate.medianPricePerM2))}`
      : "Reference mediane: a completer",
    valueEstimate.p25PricePerM2 && valueEstimate.p75PricePerM2
      ? `Fourchette: ${formatPricePerM2(numberValue(valueEstimate.p25PricePerM2))} - ${formatPricePerM2(
          numberValue(valueEstimate.p75PricePerM2),
        )}`
      : "Fourchette: a completer",
    `Echantillon: ${stringValue(valueEstimate.sampleSize, "0")} vente(s) comparable(s)`,
    `Qualite: ${stringValue(valueEstimate.qualityLabel, "fragile")}`,
    market.radiusM ? `Rayon DVF: ${market.radiusM} m` : "Rayon DVF: a completer",
    `Confiance DVF: ${stringValue(marketComparables.confidenceLabel, "a verifier")}`,
    `Audit estimation: ${stringValue(valuationAudit.summary, "audit estimation a construire")}`,
    `Score audit: ${stringValue(valuationAudit.score, "0")}/100`,
    `Impact audit: ${stringValue(valuationAudit.decisionImpact, "estimation a recouper")}`,
    ...(canShowSoldComparables
      ? [
          `Backtest estimation: ${stringValue(
            valuationBacktestSummary.interpretation,
            "backtest DVF a construire",
          )}`,
          `Erreur mediane observee: ${formatPercent(
            valuationBacktestSummary.medianAbsoluteErrorPct,
          )}`,
          `Tests utilisables: ${stringValue(valuationBacktestSummary.usableTests, "0")}`,
          `Predictions a moins de 20%: ${formatPercent(valuationBacktestSummary.within20Pct)}`,
        ]
      : []),
    `Mode comparables: ${stringValue(marketComparables.comparableModeLabel, "a completer")}`,
    `Lecture comparables: ${stringValue(marketComparables.summary, "comparables a completer")}`,
    ...(canShowNeighborhood
      ? [
          `Analyse quartier: ${stringValue(neighborhoodAnalysis.summary, "quartier a qualifier")}`,
          `Confiance quartier: ${stringValue(neighborhoodAnalysis.confidenceLabel, "a verifier")}`,
          `Position marche quartier: ${stringValue(
            neighborhoodAnalysis.marketPositionLabel,
            "marche local a calculer",
          )}`,
        ]
      : []),
    `Analyse demographique: ${stringValue(
      demographicAnalysis.summary,
      "donnees demographiques a enrichir",
    )}`,
    `Profil demographique: ${stringValue(demographicAnalysis.profileLabel, "profil local a enrichir")}`,
    ...(canShowActiveComparables
      ? [
          `Biens comparables actifs: ${stringValue(
            activeComparablesAnalysis.summary,
            "aucun comparable actif",
          )}`,
          `Confiance comparables actifs: ${stringValue(
            activeComparablesAnalysis.confidenceLabel,
            "a verifier",
          )}`,
        ]
      : []),
    ...(canShowSoldComparables && retainedComparables.length
      ? ["Transactions DVF retenues", ...retainedComparables.slice(0, 5).map((row) => `- ${row}`)]
      : []),
    ...(canShowActiveComparables && activeComparableItems.length
      ? [
          "Biens comparables en vente",
          ...activeComparableItems.slice(0, 5).map((row) => `- ${row}`),
        ]
      : []),
    ...(canShowSaleHistory && addressHistory.length
      ? ["Historique adresse", ...addressHistory.slice(0, 3).map((row) => `- ${row}`)]
      : []),
    ...(marketComparablesActions.length
      ? [
          "Actions comparables",
          ...marketComparablesActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    ...(valuationCheckpoints.length
      ? [
          "Audit de valorisation",
          ...valuationCheckpoints.slice(0, 8).map((checkpoint) => `- ${checkpoint}`),
        ]
      : []),
    ...(valuationRiskFlags.length
      ? ["Points estimation a risque", ...valuationRiskFlags.slice(0, 5).map((flag) => `- ${flag}`)]
      : []),
    ...(valuationActions.length
      ? ["Actions audit estimation", ...valuationActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(canShowSoldComparables && valuationBacktestActions.length
      ? [
          "Actions backtest estimation",
          ...valuationBacktestActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Lecture opportunite",
    `Score: ${opportunity.score != null ? `${opportunity.score}/100 - ${stringValue(opportunity.label, "a qualifier")}` : "a completer"}`,
    `Decote apparente: ${formatPercent(opportunity.apparentDiscountPct)}`,
    opportunity.estimatedMarketValue
      ? `Valeur mediane estimee: ${formatPrice(numberValue(opportunity.estimatedMarketValue))}`
      : "Valeur mediane estimee: a completer",
    opportunity.estimatedMarketLow && opportunity.estimatedMarketHigh
      ? `Fourchette de valeur: ${formatPrice(numberValue(opportunity.estimatedMarketLow))} - ${formatPrice(
          numberValue(opportunity.estimatedMarketHigh),
        )}`
      : "Fourchette de valeur: a completer",
    `Rendement brut potentiel: ${formatPercent(opportunity.grossYieldPct)}`,
    rentabilityScore.score != null
      ? `Score de rentabilite: ${rentabilityScore.score}/100 - ${stringValue(rentabilityScore.label, "a qualifier")}`
      : `Score de rentabilite: indisponible (${stringValue(rentabilityScore.reason, "donnees incompletes")})`,
    rentabilityScore.netYieldPct != null
      ? `Rendement net estime: ${formatPercent(rentabilityScore.netYieldPct)}`
      : "Rendement net estime: a completer",
    rentabilityScore.cashflowMonthly != null
      ? `Cashflow mensuel estime: ${formatPrice(numberValue(rentabilityScore.cashflowMonthly))}`
      : "Cashflow mensuel estime: a completer",
    `Frais adjudication: ${stringValue(
      auctionCostAnalysis.summary,
      "frais et consignation a confirmer",
    )}`,
    `Confiance frais: ${stringValue(auctionCostAnalysis.confidenceLabel, "a confirmer")}`,
    consignation.amountEur
      ? `Consignation source: ${formatPrice(numberValue(consignation.amountEur))}`
      : "Consignation source: a confirmer",
    acquisitionCosts.acquisitionFeesTotal
      ? `Frais estimes hors travaux: ${formatPrice(numberValue(acquisitionCosts.acquisitionFeesTotal))}`
      : "Frais estimes hors travaux: a completer",
    acquisitionCosts.totalCost
      ? `Cout complet a la mise a prix: ${formatPrice(numberValue(acquisitionCosts.totalCost))}`
      : "Cout complet a la mise a prix: a completer",
    `Travaux / etat: ${stringValue(renovationAnalysis.summary, "etat a qualifier")}`,
    `Priorite travaux: ${stringValue(renovationAnalysis.priorityLabel, "a qualifier")}`,
    renovationBudgetRange
      ? `Budget travaux indicatif: ${renovationBudgetRange}`
      : "Budget travaux indicatif: a chiffrer",
    `Impact travaux: ${stringValue(
      renovationAnalysis.decisionImpact,
      "etat a confirmer avant enchere",
    )}`,
    "",
    "Plafond d'enchere",
    ceiling.available
      ? `Mise maximum conseillee: ${formatPrice(numberValue(ceiling.maxBid))}`
      : `Mise maximum conseillee: indisponible (${stringValue(ceiling.reason, "donnees incompletes")})`,
    ceiling.targetTotalCost
      ? `Cout complet cible: ${formatPrice(numberValue(ceiling.targetTotalCost))}`
      : "Cout complet cible: a completer",
    ceiling.marketReferencePricePerM2
      ? `Reference marche retenue: ${formatPricePerM2(numberValue(ceiling.marketReferencePricePerM2))}`
      : "Reference marche retenue: a completer",
    "",
    "Preparation audience",
    `Synthese: ${stringValue(audienceReadinessAnalysis.summary, "preparation a completer")}`,
    `Statut: ${stringValue(audienceReadinessAnalysis.label, "a verifier")}`,
    `Progression: ${stringValue(audienceReadinessAnalysis.progressPct, "0")} %`,
    `Points prioritaires ouverts: ${stringValue(
      audienceReadinessAnalysis.highPriorityOpenCount,
      "0",
    )}`,
    ...(audienceChecklistItems.length
      ? audienceChecklistItems.slice(0, 8).map((item) => `- ${item}`)
      : ["- Checklist a completer dans le dossier."]),
    ...(audienceReadinessActions.length
      ? [
          "Actions preparation audience",
          ...audienceReadinessActions.slice(0, 4).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Analyse de bien",
    `Cadastre: ${stringValue(
      cadastral.summary,
      cadastral.available ? "repere disponible" : "a connecter ou confirmer",
    )}`,
    `Confiance cadastre: ${stringValue(cadastral.confidenceLabel, "a confirmer")}`,
    ...(cadastralReferences.length
      ? [`Reference(s) cadastrale(s): ${cadastralReferences.join(", ")}`]
      : []),
    cadastral.landSurfaceM2
      ? `Surface terrain: ${stringValue(cadastral.landSurfaceM2, "")} m2`
      : "Surface terrain: a confirmer",
    `DPE / diagnostics: ${stringValue(
      dpe.summary,
      dpe.available ? stringValue(dpe.class, "diagnostic repere") : "a rechercher",
    )}`,
    `Confiance DPE: ${stringValue(dpe.confidenceLabel, "a confirmer")}`,
    dpeDiagnostic.diagnosticNumber
      ? `Numero DPE: ${stringValue(dpeDiagnostic.diagnosticNumber, "")}`
      : "Numero DPE: a confirmer",
    dpe.gesClass ? `Classe GES: ${stringValue(dpe.gesClass, "")}` : "Classe GES: a confirmer",
    dpeDiagnostic.energyConsumptionKwhM2Year
      ? `Conso energie: ${stringValue(dpeDiagnostic.energyConsumptionKwhM2Year, "")} kWhEP/m2/an`
      : "Conso energie: a confirmer",
    dpeDiagnostic.emissionsKgCo2M2Year
      ? `Emissions GES: ${stringValue(dpeDiagnostic.emissionsKgCo2M2Year, "")} kgCO2/m2/an`
      : "Emissions GES: a confirmer",
    `Impact DPE: ${stringValue(dpe.impactLabel, "impact a qualifier")}`,
    `Travaux / etat: ${stringValue(renovationAnalysis.summary, "a qualifier")}`,
    `Confiance travaux: ${stringValue(renovationAnalysis.confidenceLabel, "a confirmer")}`,
    ...(canShowUrbanPlanning
      ? [
          `Urbanisme / permis: ${stringValue(
            urbanPlanningAnalysis.summary,
            "urbanisme, permis et servitudes a verifier",
          )}`,
          `Confiance urbanisme: ${stringValue(
            urbanPlanningAnalysis.confidenceLabel,
            "a verifier",
          )}`,
        ]
      : []),
    ...(canShowStreetFacade
      ? [
          `Facade et rue: ${stringValue(streetFacadeAnalysis.summary, "localisation a verifier")}`,
          `Confiance facade/rue: ${stringValue(
            streetFacadeAnalysis.confidenceLabel,
            "a confirmer",
          )}`,
          streetFacadeAnalysis.streetLevelUrl
            ? `Vue rue Mapbox: ${stringValue(streetFacadeAnalysis.streetLevelUrl, "")}`
            : "Vue rue Mapbox: a confirmer",
          streetFacadeAnalysis.aerial3dUrl
            ? `Vue 3D: ${stringValue(streetFacadeAnalysis.aerial3dUrl, "")}`
            : "Vue 3D: a confirmer",
        ]
      : []),
    `Services de proximite: ${stringValue(
      nearbyServices.summary,
      nearbyServices.available ? "signaux de proximite reperes" : "a qualifier",
    )}`,
    `Confiance proximite: ${stringValue(nearbyServices.confidenceLabel, "a confirmer")}`,
    nearbyCategories.length
      ? `Familles de services: ${nearbyCategories.join(", ")}`
      : "Familles de services: a mesurer",
    `Demographie: ${stringValue(demographicAnalysis.summary, "donnees locales a enrichir")}`,
    `Confiance demographie: ${stringValue(demographicAnalysis.confidenceLabel, "a verifier")}`,
    `Demande locale: ${stringValue(demographicAnalysis.demandLabel, "demande a qualifier")}`,
    ...(canShowNeighborhood
      ? [
          `Quartier: ${stringValue(neighborhoodAnalysis.summary, "a qualifier")}`,
          `Dimensions quartier: ${
            normalizeStringList(neighborhoodAnalysis.dimensions).join(", ") || "a enrichir"
          }`,
        ]
      : []),
    ...(canShowActiveComparables
      ? [`Comparables actifs: ${stringValue(activeComparablesAnalysis.summary, "a rechercher")}`]
      : []),
    `Documents: ${stringValue(analysis.documentsCount, "0")} piece(s)`,
    ...(occupancyEvidence.length
      ? ["Indices occupation", ...occupancyEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(occupancyNextActions.length
      ? ["Actions occupation", ...occupancyNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(auctionCostSignals.length
      ? ["Signaux frais", ...auctionCostSignals.slice(0, 4).map((signal) => `- ${signal}`)]
      : []),
    ...(auctionCostActions.length
      ? ["Actions frais", ...auctionCostActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(dpeEvidence.length
      ? ["Indices DPE / diagnostics", ...dpeEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(dpeNextActions.length
      ? ["Actions DPE", ...dpeNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(renovationEvidence.length
      ? ["Indices travaux / etat", ...renovationEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(renovationActions.length
      ? ["Actions travaux", ...renovationActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningItems.length
      ? ["Signaux urbanisme/permis", ...urbanPlanningItems.slice(0, 6).map((item) => `- ${item}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningMissingChecks.length
      ? [
          "Controles urbanisme manquants",
          ...urbanPlanningMissingChecks.slice(0, 4).map((check) => `- ${check}`),
        ]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningActions.length
      ? [
          "Actions urbanisme/permis",
          ...urbanPlanningActions.slice(0, 4).map((action) => `- ${action}`),
        ]
      : []),
    ...(canShowStreetFacade && streetFacadeActions.length
      ? ["Actions facade/rue", ...streetFacadeActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowStreetFacade && streetFacadeLimitations.length
      ? [
          "Limites facade/rue",
          ...streetFacadeLimitations.slice(0, 2).map((limitation) => `- ${limitation}`),
        ]
      : []),
    ...(canShowNeighborhood && neighborhoodSignals.length
      ? ["Signaux quartier", ...neighborhoodSignals.slice(0, 5).map((signal) => `- ${signal}`)]
      : []),
    ...(canShowNeighborhood && neighborhoodActions.length
      ? ["Actions quartier", ...neighborhoodActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowActiveComparables && activeComparableActions.length
      ? [
          "Actions comparables actifs",
          ...activeComparableActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Revue juridique",
    `Synthese: ${stringValue(legalAttentionAnalysis.summary, "points juridiques a relire")}`,
    `Niveau: ${stringValue(legalAttentionAnalysis.confidenceLabel, "a verifier")}`,
    ...(legalAttentionItems.length
      ? legalAttentionItems.slice(0, 6).map((item) => `- ${item}`)
      : ["- Relire les pieces officielles avant toute enchere."]),
    ...(legalAttentionActions.length
      ? ["Actions juridiques", ...legalAttentionActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(cadastralNextActions.length
      ? ["Actions cadastre", ...cadastralNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(nearbyNextActions.length
      ? ["Actions proximite", ...nearbyNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(demographicSignals.length
      ? ["Signaux demographiques", ...demographicSignals.slice(0, 6).map((signal) => `- ${signal}`)]
      : []),
    ...(demographicMissingData.length
      ? [
          "Donnees demographiques manquantes",
          ...demographicMissingData.slice(0, 4).map((item) => `- ${item}`),
        ]
      : []),
    ...(demographicActions.length
      ? ["Actions demographie", ...demographicActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(sourceTrace.length
      ? [
          "",
          "Sources et tracabilite",
          ...sourceTrace
            .slice(0, 8)
            .map((entry) =>
              [
                `- ${entry.label}`,
                entry.sourceName,
                entry.url ? `URL: ${entry.url}` : null,
                entry.confidenceLabel ? `Confiance: ${entry.confidenceLabel}` : null,
              ]
                .filter(Boolean)
                .join(" | "),
            ),
        ]
      : []),
    ...(limitations.length
      ? ["", "Limites", ...limitations.slice(0, 6).map((limitation) => `- ${limitation}`)]
      : []),
    ...(legalAttentionPoints.length
      ? [
          "",
          "Points d'attention",
          ...legalAttentionPoints.map((point) => `- ${stringValue(point, "")}`),
        ]
      : []),
    "",
    "Notes",
    report.user_notes || "Aucune note utilisateur.",
    "",
    "Avertissement",
    complianceNotice,
  ];
}

function pdfWatermarkForPlan(plan: PlanEntitlements): string | null {
  return plan.features.pdfExport === "limited" ? "VERSION DECOUVERTE - EXTRAIT LIMITE" : null;
}

function attachPlan(report: SavedReportRow, plan: PlanEntitlements): SavedPropertyReport {
  return { ...report, plan };
}

function appSaleRowToAuctionSale(row: AppSaleRow): AuctionSale {
  return {
    ...(row as unknown as AuctionSale),
    id: row.id ?? "",
    documents_rich: Array.isArray(row.documents_rich)
      ? (row.documents_rich as unknown as SaleDocumentRich[])
      : null,
    media: Array.isArray(row.media) ? (row.media as unknown as SaleMedia[]) : null,
    risks: Array.isArray(row.risks) ? (row.risks as SaleRisk[]) : null,
    score_factors: Array.isArray(row.score_factors)
      ? (row.score_factors as unknown as SaleScoreFactor[])
      : null,
    source_blocks:
      row.source_blocks && typeof row.source_blocks === "object"
        ? (row.source_blocks as Record<string, unknown>)
        : null,
    source_blocks_by_source:
      row.source_blocks_by_source && typeof row.source_blocks_by_source === "object"
        ? (row.source_blocks_by_source as Record<string, Record<string, unknown>>)
        : null,
  };
}

function normalizeRisks(risks: AuctionSale["risks"]) {
  if (!Array.isArray(risks)) return [];
  return risks.map((risk) => ({
    type: risk.risk_type,
    label: risk.risk_label,
    severity: risk.severity,
    evidence: risk.evidence,
    confidence: risk.confidence ?? null,
  }));
}

function normalizeScoreFactors(factors: AuctionSale["score_factors"]) {
  if (!Array.isArray(factors)) return [];
  return factors
    .map((factor) => ({
      key: factor.factor_key,
      label: factor.label,
      reason: factor.reason,
      delta: factor.delta,
      confidencePct:
        typeof factor.confidence === "number" ? roundPercent(factor.confidence * 100) : null,
      evidence: factor.evidence ?? null,
    }))
    .filter((factor) => factor.label || factor.reason || factor.delta != null);
}

function deriveOpportunityScore({
  apparentDiscountPct,
  grossYieldPct,
  ceilingSnapshot,
}: {
  apparentDiscountPct: number | null;
  grossYieldPct: number | null;
  ceilingSnapshot: ReturnType<typeof buildCeilingSnapshot>;
}): number | null {
  if (apparentDiscountPct == null && grossYieldPct == null && !ceilingSnapshot.available) {
    return null;
  }

  let score = 50;
  if (apparentDiscountPct != null) {
    if (apparentDiscountPct >= 35) score += 24;
    else if (apparentDiscountPct >= 25) score += 18;
    else if (apparentDiscountPct >= 15) score += 11;
    else if (apparentDiscountPct < 0) score -= 12;
  }
  if (grossYieldPct != null) {
    if (grossYieldPct >= 9) score += 12;
    else if (grossYieldPct >= 6.5) score += 8;
    else if (grossYieldPct < 3) score -= 8;
  }
  if (ceilingSnapshot.available) {
    if ((ceilingSnapshot.marginTotal ?? 0) > 0) score += 7;
    if ((ceilingSnapshot.marginTotal ?? 0) < 0) score -= 10;
  } else {
    score -= 6;
  }

  return clampScore(Math.round(score));
}

function opportunityScoreLabel(score: number | null): string {
  if (score == null) return "À compléter";
  if (score >= 80) return "Très favorable";
  if (score >= 65) return "À étudier en priorité";
  if (score >= 50) return "À analyser";
  return "Prudence renforcée";
}

function opportunitySummary({
  apparentDiscountPct,
  grossYieldPct,
  score,
  ceilingAvailable,
}: {
  apparentDiscountPct: number | null;
  grossYieldPct: number | null;
  score: number | null;
  ceilingAvailable: boolean;
}): string {
  const parts: string[] = [];
  if (score != null) parts.push(`score ${score}/100`);
  if (apparentDiscountPct != null)
    parts.push(`décote apparente ${formatPercent(apparentDiscountPct)}`);
  if (grossYieldPct != null) parts.push(`rendement brut estimé ${formatPercent(grossYieldPct)}`);
  if (!ceilingAvailable) parts.push("plafond à compléter");
  return parts.length ? parts.join(" · ") : "Données à compléter avant décision.";
}

function dpeFromSourceBlocks(blocks: AuctionSale["source_blocks"]): string | null {
  if (!blocks || typeof blocks !== "object") return null;
  const value = blocks.dpe_classe ?? blocks.dpe ?? blocks.diagnostic_dpe;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

function defaultReportTitle(sale: AuctionSale): string {
  const place = [sale.city, sale.department].filter(Boolean).join(" ");
  return `Rapport ${propertyTypeLabel(sale.property_type)}${place ? ` - ${place}` : ""}`;
}

function saleLocation(sale: AuctionSale): string | null {
  const value = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  return value || null;
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeSourceTrace(value: unknown): SourceTraceEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      const id = stringValue(record.id, "");
      const kind = stringValue(record.kind, "judicial_listing");
      const label = stringValue(record.label, "");
      const sourceName = stringValue(record.sourceName, "Source");
      const url = stringValue(record.url, "");
      const capturedAt = stringValue(record.capturedAt, "");
      const confidenceLabel = stringValue(record.confidenceLabel, "A confirmer");
      const detail = stringValue(record.detail, "");
      const limitation = stringValue(record.limitation, "");

      if (!label && !sourceName && !url) return null;

      return {
        id: id || `${kind}-${label || sourceName}`,
        kind: kind as SourceTraceEntry["kind"],
        label: label || "Source",
        sourceName,
        url: url || null,
        capturedAt: capturedAt || null,
        confidenceLabel,
        detail,
        limitation,
      };
    })
    .filter((entry): entry is SourceTraceEntry => Boolean(entry));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeCadastralReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const section = stringValue(record.section, "");
      const number = stringValue(record.number, "");
      const raw = stringValue(record.raw, "");
      if (section && number) return `Section ${section} n° ${number}`;
      return raw;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeNearbyCategoryLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringValue(record.status, "");
      if (status !== "mentioned") return "";
      return stringValue(record.label, "");
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeOccupancyEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeDpeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeRenovationEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const excerpt = stringValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeNeighborhoodSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const status = stringValue(record.status, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      return [label, status ? status.toUpperCase() : null, source, detail]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeDemographicSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringValue(record.status, "");
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      const impact = stringValue(record.impact, "");
      return [status ? status.toUpperCase() : null, label, source, detail, impact]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeLegalAttentionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = stringValue(record.priority, "");
      const label = stringValue(record.label, "");
      const reason = stringValue(record.reason, "");
      const action = stringValue(record.action, "");
      return [
        priority ? priority.toUpperCase() : null,
        label,
        reason,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeUrbanPlanningItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = stringValue(record.priority, "");
      const status = stringValue(record.status, "");
      const label = stringValue(record.label, "");
      const source = stringValue(record.source, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [
        priority ? priority.toUpperCase() : null,
        status ? status.toUpperCase() : null,
        label,
        source,
        detail,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeMarketComparableRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const date = stringValue(record.date, "");
      const type = stringValue(record.type, "Bien");
      const totalPrice = numberValue(record.totalPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const distance = numberValue(record.distanceM);
      return [
        date ? formatDate(date) : null,
        type,
        totalPrice != null ? formatPrice(totalPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m2` : null,
        distance != null ? `${Math.round(distance)} m` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeValuationCheckpoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringValue(record.status, "");
      const label = stringValue(record.label, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [
        status ? status.toUpperCase() : null,
        label,
        detail,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeActiveComparableItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const title = stringValue(record.title, "Bien actif");
      const city = stringValue(record.city, "");
      const saleDate = stringValue(record.saleDate, "");
      const startingPrice = numberValue(record.startingPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const matchLabel = stringValue(record.matchLabel, "");
      const matchScore = numberValue(record.matchScore);
      return [
        matchLabel && matchScore != null ? `${matchLabel} (${matchScore}/100)` : matchLabel,
        title,
        city,
        saleDate ? formatDate(saleDate) : null,
        startingPrice != null ? formatPrice(startingPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m2` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeAudienceChecklistItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringValue(record.label, "");
      const status = stringValue(record.status, "");
      const priority = stringValue(record.priority, "");
      const detail = stringValue(record.detail, "");
      const action = stringValue(record.action, "");
      return [
        status ? status.toUpperCase() : null,
        priority ? `Priorite ${priority}` : null,
        label,
        detail,
        action ? `Action: ${action}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .slice(0, 12);
}

function stringValue(value: unknown, fallback: string | null): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback ?? "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function roundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function roundPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: unknown): string {
  const number = numberValue(value);
  if (number == null) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(number)} %`;
}

function formatRenovationBudgetRange(range: Record<string, unknown>): string {
  const lowEur = numberValue(range.lowEur);
  const highEur = numberValue(range.highEur);
  if (lowEur != null && highEur != null) {
    return `${formatPrice(lowEur)} - ${formatPrice(highEur)}`;
  }
  const lowPerM2 = numberValue(range.lowPerM2);
  const highPerM2 = numberValue(range.highPerM2);
  if (lowPerM2 != null && highPerM2 != null) {
    return `${formatPricePerM2(lowPerM2)} - ${formatPricePerM2(highPerM2)}`;
  }
  return "";
}

function slugify(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "rapport-immojudis"
  );
}

function createShareToken(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeShareToken(value: string): string | null {
  const token = value.trim();
  return /^[A-Za-z0-9_-]{24,120}$/.test(token) ? token : null;
}

function normalizeShareExpiresAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Date d'expiration invalide.");
  return date.toISOString();
}

function shareIsExpired(value: string | null): boolean {
  return Boolean(value && new Date(value).getTime() <= Date.now());
}
