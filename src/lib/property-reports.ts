import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { getEnvironmentalContext } from "@/lib/environment.functions";
import {
  isPlanPeriodActive,
  normalizePlanCode,
  pastDueGraceEnd,
  PLAN_LIMITS,
  type FeatureAccess,
  type FeatureKey,
  type PlanBilling,
  type PlanCode,
  type PlanStatus,
} from "@/lib/plans";
import { createTextPdf } from "@/lib/simple-pdf";
import { REPORT_COMPLIANCE_NOTICE, type SourceTraceEntry } from "@/lib/source-traceability";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { getPublicationVisibleSaleIds } from "@/lib/sale-publication-guard";
import type { AuctionSale } from "@/lib/types";
import {
  buildCeilingSnapshot,
  buildMarketSnapshot,
  buildReportSnapshot,
} from "./property-report/analysis";
import {
  assertEntitlementIncluded,
  assertPdfExportAvailable,
  assertReportCreationAvailable,
  buildPlanEntitlements,
  emptyActiveComparableSales,
  featureUnlocked,
  sanitizeReportSnapshotForPlan,
} from "./property-report/entitlements";
import { reportToPdfLines, REPORT_PDF_HEADINGS } from "./property-report/pdf";
import {
  assertReportSourceCurrent,
  reportSourceFingerprint,
} from "./property-report/source-integrity";
import {
  getActiveComparableSales,
  getCadastralParcels,
  getDpeDiagnostics,
  getExistingReportId,
  getReport,
  getSale,
  getUrbanPlanningSignals,
  getValuationBacktestForReport,
  recordPdfExport,
} from "./property-report/repository";
import {
  asJson,
  attachPlan,
  createShareToken,
  defaultReportTitle,
  emptyToNull,
  hashShareToken,
  normalizeShareExpiresAt,
  normalizeShareToken,
  normalizeSourceTrace,
  normalizeStringList,
  pdfWatermarkForPlan,
  saleLocation,
  shareIsExpired,
  slugify,
} from "./property-report/serialization";
import { asRecord, stringOrNumberValue } from "@/lib/guards";
export type SupabaseClient = SupabaseAuthContext["supabase"];
export type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];
export type SavedReportRow = Database["public"]["Tables"]["saved_property_reports"]["Row"];
export type CadastreParcelRow = Database["public"]["Tables"]["auction_cadastre_parcels"]["Row"];
export type DpeDiagnosticRow = Database["public"]["Tables"]["auction_dpe_diagnostics"]["Row"];
export type UrbanPlanningSignalRow =
  Database["public"]["Tables"]["auction_urban_planning_signals"]["Row"];
export type ActiveComparableSales = {
  scopeLabel: string;
  sales: AuctionSale[];
};

import { computeReportSimulation, reportSimulationSchema } from "./report-simulation";
import { listingValuationConflict } from "./listing-evidence";

export const propertyReportRequestSchema = z.object({
  saleId: z.string().uuid(),
  reportKind: z.enum(["opportunity", "market", "bid_ceiling"]).default("opportunity"),
  title: z.string().trim().min(3).max(140).optional(),
  userNotes: z.string().trim().max(2500).optional(),
  includeEnvironment: z.boolean().default(false),
  simulation: reportSimulationSchema.optional(),
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
  hasAnalysisAccess: boolean;
  currentPeriodEnd: string | null;
  billing?: PlanBilling;
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
    valueEstimate: FeatureAccess;
    cadastralAnalysis: FeatureAccess;
    nearbyServices: FeatureAccess;
    savedReports: FeatureAccess;
    pdfExport: FeatureAccess;
    reportEditing: FeatureAccess;
    urbanPlanning: FeatureAccess;
    streetFacade: FeatureAccess;
    saleHistory: FeatureAccess;
    soldComparables: FeatureAccess;
    activeComparables: FeatureAccess;
    neighborhoodAnalysis: FeatureAccess;
    outcomeGraph: FeatureAccess;
    bidCeiling: FeatureAccess;
    advancedBidScenarios: FeatureAccess;
    dpeMap: FeatureAccess;
    lawyerDirectory: FeatureAccess;
    lawyerReferrals: FeatureAccess;
    audienceTracking: FeatureAccess;
    workspaceCollaboration: FeatureAccess;
  };
};

const ADMIN_PLAN_LIMITS: PlanEntitlements["limits"] = {
  propertyReportsPerMonth: null,
  pdfExportsPerMonth: null,
  savedReports: null,
  reportEditing: "full",
  favoriteSales: null,
  watchedZones: null,
  saleAnalysisSets: null,
  saleAnalysisItems: null,
  apiKeys: null,
  workspaceCollaborators: null,
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

export type PropertyReportDetailResponse = PropertyReportSaveResponse;

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

export { buildOpportunityAnalysis } from "./property-report/analysis";

export async function listPropertyReports({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId?: string | null;
}): Promise<PropertyReportListResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés au plan Analyse.");
  let query = auth.supabase
    .from("saved_property_reports")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false });

  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error } = await query.limit(50);
  if (error) throw error;

  const reports = data ?? [];
  const visibleSaleIds = await getPublicationVisibleSaleIds(
    reports.map((report) => report.sale_id),
  );

  return {
    // A report snapshot can outlive the source listing. Do not return stale
    // sale facts after the source is quarantined, even if the report belongs
    // to the requesting user and RLS still allows the report row.
    reports: reports
      .filter((report) => visibleSaleIds.has(report.sale_id))
      .map((report) => attachPlan(report, plan)),
    plan,
  };
}

export async function getPropertyReport({
  auth,
  reportId,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
}): Promise<PropertyReportDetailResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés au plan Analyse.");
  const report = await getReport(auth.supabase, auth.userId, reportId);

  return {
    report: attachPlan(report, plan),
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
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés au plan Analyse.");
  const existingReportId = await getExistingReportId(
    auth.supabase,
    auth.userId,
    input.saleId,
    input.reportKind,
  );
  if (!existingReportId) await assertReportCreationAvailable(auth, plan);

  const sale = await getSale(auth.supabase, input.saleId);
  const valuationConflict = listingValuationConflict(sale);
  if (valuationConflict) throw new Error(valuationConflict);
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
  if (input.simulation) {
    const personal = computeReportSimulation(sale, marketEstimate, input.simulation);
    Object.assign(ceilingSnapshot, personal, {
      personalSimulation: input.simulation,
      acquisition: personal.simulated,
      refreshWorksBudget: input.simulation.works,
      maxBidWithoutWorks: null,
      maxBidWithRefreshWorks: null,
    });
  }
  const reportSnapshot = {
    ...buildReportSnapshot({
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
    }),
    sourceFingerprint: reportSourceFingerprint(sale),
  };
  const title = input.title?.trim() || defaultReportTitle(sale);

  const { data, error } = await supabaseAdmin
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
  assertEntitlementIncluded(
    plan,
    "property.reportEditing",
    "Édition des rapports réservée au plan Analyse.",
  );
  // Resolve and publication-check the owned report before returning its
  // snapshot through the privileged update client.
  await getReport(auth.supabase, auth.userId, reportId);
  const patch: Database["public"]["Tables"]["saved_property_reports"]["Update"] = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.userNotes !== undefined) patch.user_notes = emptyToNull(input.userNotes ?? undefined);

  const { data, error } = await supabaseAdmin
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
  const { error } = await supabaseAdmin
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
  assertEntitlementIncluded(plan, "property.pdfExport", "Export PDF réservé au plan Analyse.");
  await assertPdfExportAvailable(auth, plan);
  const report = await getReport(auth.supabase, auth.userId, reportId);
  assertReportSourceCurrent(report.report_snapshot, await getSale(auth.supabase, report.sale_id));
  const lines = reportToPdfLines(report, plan);
  const bytes = createTextPdf({
    title: report.title,
    lines,
    headings: REPORT_PDF_HEADINGS,
    footer:
      "Immojudis - rapport indicatif. Vérifiez les pièces officielles et votre conseil avant toute enchère.",
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
  assertEntitlementIncluded(plan, "property.savedReports", "Partage réservé au plan Analyse.");
  const report = await getReport(auth.supabase, auth.userId, reportId);
  assertReportSourceCurrent(report.report_snapshot, await getSale(auth.supabase, report.sale_id));
  const shareToken = createShareToken();
  const shareExpiresAt = normalizeShareExpiresAt(expiresAt);
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .update({
      share_enabled: true,
      // Only the digest is persisted; the clear token goes back to the owner once.
      share_token: null,
      share_token_hash: hashShareToken(shareToken),
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
    share: buildPropertyReportShare(data, origin, shareToken),
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
  assertEntitlementIncluded(plan, "property.savedReports", "Partage réservé au plan Analyse.");
  await getReport(auth.supabase, auth.userId, reportId);

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .update({
      share_enabled: false,
      share_token: null,
      share_token_hash: null,
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
      "id,user_id,sale_id,title,report_kind,report_snapshot,market_snapshot,environmental_snapshot,ceiling_snapshot,share_enabled,shared_at,share_expires_at,share_view_count,updated_at",
    )
    .eq("share_token_hash", hashShareToken(normalized))
    .eq("share_enabled", true)
    .maybeSingle();

  if (error) throw error;
  if (!data || shareIsExpired(data.share_expires_at)) {
    throw new Error("Rapport partagé introuvable ou expiré.");
  }
  // A link stops working as soon as its owner no longer has an active Analyse plan.
  if (!(await shareOwnerKeepsSavedReports(data.user_id))) {
    throw new Error("Rapport partagé introuvable ou expiré.");
  }

  assertReportSourceCurrent(data.report_snapshot, await getSale(supabaseAdmin, data.sale_id));

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

/**
 * Whether the owner of a shared report still holds a plan that includes saved reports.
 * Shared links are cut when the subscription ends (no active period, past due, cancelled).
 */
export async function shareOwnerKeepsSavedReports(userId: string): Promise<boolean> {
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("user_profiles")
    .select("account_tier,user_role")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.user_role === "admin" || profile?.account_tier === "premium") return true;

  const { data: subscription, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("plan_code,status,current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const plan =
    subscription && isPlanPeriodActive(subscription.status, subscription.current_period_end)
      ? normalizePlanCode(subscription.plan_code)
      : "decouverte";
  return featureUnlocked(buildPlanEntitlements(plan).features.savedReports);
}

export function buildPropertyReportShare(
  report: Pick<
    SavedReportRow,
    "share_enabled" | "shared_at" | "share_expires_at" | "share_view_count"
  > &
    Partial<Pick<SavedReportRow, "share_token" | "share_token_hash">>,
  origin?: string | null,
  // The clear token exists only in the response that creates the link; the database
  // keeps its digest, so an existing share cannot be re-displayed (rotate to get a new URL).
  issuedToken?: string | null,
): PropertyReportShare {
  const token = issuedToken ?? report.share_token ?? null;
  const enabled = Boolean(
    report.share_enabled &&
    (token || report.share_token_hash) &&
    !shareIsExpired(report.share_expires_at),
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
    disclaimer: stringOrNumberValue(traceability.complianceNotice, REPORT_COMPLIANCE_NOTICE),
  };
}

export async function resolvePlanEntitlements(
  auth: SupabaseAuthContext,
): Promise<PlanEntitlements> {
  if (auth.isAdmin) {
    return buildPlanEntitlements("analyse", null, ADMIN_PLAN_LIMITS);
  }
  if (auth.accountTier === "premium") {
    return buildPlanEntitlements("analyse", null);
  }

  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select("plan_code,status,current_period_end,stripe_customer_id")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  const plan =
    data && isPlanPeriodActive(data.status, data.current_period_end)
      ? normalizePlanCode(data.plan_code)
      : "decouverte";
  return buildPlanEntitlements(plan, data?.current_period_end ?? null, PLAN_LIMITS[plan], {
    status: (data?.status as PlanStatus | undefined) ?? null,
    hasStripeCustomer: Boolean(data?.stripe_customer_id),
    graceEndsAt: data?.status === "past_due" ? pastDueGraceEnd(data.current_period_end) : null,
  });
}

export async function assertFeatureEntitlement(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  message = "Fonctionnalité réservée au plan Analyse.",
): Promise<PlanEntitlements> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, feature, message);
  return plan;
}
