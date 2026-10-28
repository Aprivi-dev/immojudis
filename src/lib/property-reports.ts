import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { getEnvironmentalContext } from "@/lib/environmental-context";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";
import { DEFAULT_OPEN_FEE_REGIMES, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { redactPersonalData, redactPersonalText } from "@/lib/personal-data-filter";
import {
  isPlanPeriodActive,
  normalizePlanCode,
  pastDueGraceEnd,
  PLAN_LIMITS,
  featureIncluded,
  isSaleUnlockFeature,
  type FeatureAccess,
  type FeatureKey,
  type PlanBilling,
  type PlanCode,
  type PlanStatus,
  isTrialExtensionRow,
} from "@/lib/plans";
import { enforceDailyOperationLimits } from "@/lib/rate-limit";
import { createTextPdf } from "@/lib/simple-pdf";
import { REPORT_COMPLIANCE_NOTICE, type SourceTraceEntry } from "@/lib/source-traceability";
import { hasActiveSignupTrial, readSignupTrial } from "@/lib/launch-offer.server";
import { hasUnlockedSale } from "@/lib/sale-unlocks.server";
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
import { analysisForOpenRegimes, ceilingForOpenRegimes } from "./property-report/ceiling-switch";
import { reportToPdfLines, REPORT_PDF_HEADINGS } from "./property-report/pdf";
import { reportWording } from "./property-report/report-wording";
import { SharedReportUnavailableError } from "./property-report/share-unavailable";
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
import { asRecord, numberValue, stringOrNumberValue } from "@/lib/guards";
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

import {
  computeReportSimulation,
  publicReportSimulation,
  reportSimulationSchema,
} from "./report-simulation";
import { listingValuationConflict } from "./listing-evidence";
import { loadSaleRentReference } from "@/lib/rent-reference.server";

export const propertyReportRequestSchema = z.object({
  saleId: z.string().guid(),
  reportKind: z.enum(["opportunity", "market", "bid_ceiling"]).default("opportunity"),
  title: z.string().trim().min(3).max(140).optional(),
  userNotes: z.string().trim().max(2500).optional(),
  includeEnvironment: z.boolean().default(false),
  // `reportSimulationSchema` est un schéma zod/mini (partagé avec le navigateur).
  simulation: z.optional(reportSimulationSchema),
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
  /**
   * Le plan est Analyse grâce à l'essai gratuit de 7 jours à l'inscription (le mécanisme de l'offre
   * de lancement : compte gratuit surclassé pendant son essai, tant que `app_private.launch_offer`
   * est active). Absent pour un abonné, un compte premium ou un administrateur.
   */
  launchOffer?: true;
  /** Fin de l'essai en cours (ISO), quand la base la connaît. */
  trialEndsAt?: string;
  /** L'essai a été prolongé par l'administrateur : `trialEndsAt` est la fin de la prolongation. */
  trialExtension?: true;
  /** Fin d'un essai terminé (ISO) : le compte est revenu à Découverte. */
  trialEndedAt?: string;
  /** La base refuse l'essai à ce compte (pas le premier de son adresse, adresse jetable). */
  trialDenied?: true;
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
  monthlyUnlocks: null,
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

export type PublicSharedCeiling = {
  available: boolean;
  /** « Enchère plafond (simulation) » ou « Offre plafond (simulation) » ; `null` : rapport ancien. */
  label?: string | null;
  /** Régime de frais du plafond (`tribunal`, `notary_auction`, `notary_online`) ; `null` : rapport ancien. */
  regime?: string | null;
  /** Ce que le calcul ne couvre pas (vente notariale), `null` sinon. */
  scopeNote?: string | null;
  /** Mention d'une vente par offres : le vendeur n'est pas tenu de retenir la meilleure offre. */
  reserveNotice?: string | null;
  /** Libellés des frais qui viennent d'une valeur par défaut, à confirmer. */
  estimatedFees?: string[];
  /** Ce que la raison d'un plafond indisponible dit (`NO_CEILING_REGIME_REASON`, plafond non rentable). */
  reason?: string | null;
  maxBid: number | null;
  safetyDiscountPct: number | null;
  basisLabel: string | null;
  personalSimulation?: Record<string, unknown>;
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
  /** Allow-list of the ceiling: only what the shared page renders, never the private inputs. */
  ceiling: PublicSharedCeiling;
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
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés à l’offre Analyse.");
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
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés à l’offre Analyse.");
  const report = await getReport(auth.supabase, auth.userId, reportId);

  return {
    report: attachPlan(report, plan),
    plan,
  };
}

export async function savePropertyReport({
  auth,
  input,
  request,
}: {
  auth: SupabaseAuthContext;
  input: PropertyReportRequestPayload;
  /** Requête HTTP d'origine : sert au plafond journalier par adresse. */
  request: Request;
}): Promise<PropertyReportSaveResponse> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.savedReports", "Rapports réservés à l’offre Analyse.");
  // Après le droit d'accès : un compte sans droit ne doit pas user les compteurs de son adresse ni
  // le disjoncteur global. Le quota mensuel de l'offre Analyse est illimité, ce plafond est le seul.
  await enforceDailyOperationLimits({
    request,
    userId: auth.userId,
    operation: "propertyReportCreate",
    launchOffer: plan.launchOffer === true,
  });
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
  // The fee regimes open on the server decide whether the sale has a ceiling at all.
  const regimes = openFeeRegimesFromEnv();
  // Même référence de loyer (carte ANIL à la commune) que la fiche de la vente : sans elle, le plafond
  // du rapport et celui de la fiche différeraient.
  const rentReference = await loadSaleRentReference(sale);
  const ceilingSnapshot = buildCeilingSnapshot(sale, marketEstimate, {}, regimes, rentReference);
  if (input.simulation) {
    const personal = computeReportSimulation(
      sale,
      marketEstimate,
      input.simulation,
      regimes,
      rentReference,
    );
    Object.assign(ceilingSnapshot, personal, { personalSimulation: input.simulation });
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
      rentReference,
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
    "Édition des rapports réservée à l’offre Analyse.",
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
  request,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
  /** Requête HTTP d'origine : sert au plafond journalier par adresse. */
  request: Request;
}): Promise<PropertyReportExport> {
  const plan = await resolvePlanEntitlements(auth);
  assertEntitlementIncluded(plan, "property.pdfExport", "Export PDF réservé à l’offre Analyse.");
  await enforceDailyOperationLimits({
    request,
    userId: auth.userId,
    operation: "propertyReportPdf",
    launchOffer: plan.launchOffer === true,
  });
  await assertPdfExportAvailable(auth, plan);
  const report = await getReport(auth.supabase, auth.userId, reportId);
  assertReportSourceCurrent(report.report_snapshot, await getSale(auth.supabase, report.sale_id));
  const lines = reportToPdfLines(report, plan, openFeeRegimesFromEnv());
  const bytes = createTextPdf({
    title: report.title,
    lines,
    headings: REPORT_PDF_HEADINGS,
    // Le régime vient du plafond enregistré : un rapport notarial par offres ne parle pas d'enchère.
    footer: reportWording(asRecord(report.ceiling_snapshot).regime).footerSentence,
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
  assertEntitlementIncluded(plan, "property.savedReports", "Partage réservé à l’offre Analyse.");
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
  assertEntitlementIncluded(plan, "property.savedReports", "Partage réservé à l’offre Analyse.");
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
  if (!data) throw new Error("Rapport partagé introuvable ou expiré.");
  // Lien connu mais fermé (échéance, fin de l'essai du propriétaire) : la page l'explique.
  if (shareIsExpired(data.share_expires_at)) throw new SharedReportUnavailableError();
  // A link stops working as soon as its owner no longer has an active Analyse plan.
  if (!(await shareOwnerKeepsSavedReports(data.user_id))) throw new SharedReportUnavailableError();

  assertReportSourceCurrent(data.report_snapshot, await getSale(supabaseAdmin, data.sale_id));

  if (countView) {
    const nextViewCount = data.share_view_count + 1;
    const { error: updateError } = await supabaseAdmin
      .from("saved_property_reports")
      .update({ share_view_count: nextViewCount })
      .eq("id", data.id);
    if (!updateError) data.share_view_count = nextViewCount;
  }

  return buildPublicSharedPropertyReport(data, openFeeRegimesFromEnv());
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
  // Essai gratuit : les liens partagés par un compte gratuit restent ouverts tant qu'il dure (la
  // lecture de l'essai applique l'interrupteur : un essai commencé avant la coupure continue).
  if (profile && (await hasActiveSignupTrial(userId))) return true;

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

/**
 * Liste blanche de l'enchère plafond exposée par un lien public. Le snapshot complet contient les
 * entrées privées du propriétaire (loyer, mensualité, charges, taxe foncière) : seuls les champs
 * que la page partagée affiche sont recopiés. `market_snapshot` et `environmental_snapshot` ne
 * sont pas rendus par cette page et ne sont donc pas renvoyés.
 */
function buildPublicSharedCeiling(
  snapshot: Json,
  regimes: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): PublicSharedCeiling {
  // Régime fermé depuis l'enregistrement du rapport : plafond indisponible, montants masqués.
  const ceiling = ceilingForOpenRegimes(asRecord(snapshot), regimes);
  const personalSimulation = publicReportSimulation(ceiling.personalSimulation);
  const estimatedFees = Array.isArray(ceiling.estimatedFees)
    ? ceiling.estimatedFees.flatMap((fee) => {
        const label = asRecord(fee).label;
        return typeof label === "string" && label ? [label] : [];
      })
    : [];
  return {
    available: ceiling.available === true,
    label: typeof ceiling.label === "string" ? ceiling.label : null,
    regime: typeof ceiling.regime === "string" ? ceiling.regime : null,
    scopeNote: typeof ceiling.scopeNote === "string" ? ceiling.scopeNote : null,
    reserveNotice: typeof ceiling.reserveNotice === "string" ? ceiling.reserveNotice : null,
    estimatedFees,
    reason: typeof ceiling.reason === "string" ? ceiling.reason : null,
    maxBid: numberValue(ceiling.maxBid),
    safetyDiscountPct: numberValue(ceiling.safetyDiscountPct),
    basisLabel: typeof ceiling.basisLabel === "string" ? ceiling.basisLabel : null,
    ...(personalSimulation ? { personalSimulation } : {}),
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
  /** Régimes de frais ouverts (`openFeeRegimesFromEnv`) ; absent : tous ceux qui sont définis. */
  regimes: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): PublicSharedPropertyReport {
  const rawSnapshot = asRecord(report.report_snapshot);
  const snapshot = sanitizeReportSnapshotForPlan(
    rawSnapshot,
    buildPlanEntitlements(normalizePlanCode(rawSnapshot.plan)),
  );
  const traceability = asRecord(snapshot.sourceTraceability);
  const savedCeiling = asRecord(report.ceiling_snapshot);

  // Lecture publique par lien : un rapport figé avant le durcissement du filtre est refiltré ici.
  return {
    id: report.id,
    title: redactPersonalText(report.title),
    reportKind: report.report_kind,
    updatedAt: report.updated_at,
    sharedAt: report.shared_at,
    expiresAt: report.share_expires_at,
    viewCount: report.share_view_count,
    plan: typeof snapshot.plan === "string" ? snapshot.plan : null,
    sale: redactPersonalData(asRecord(snapshot.sale)),
    analysis: redactPersonalData(
      analysisForOpenRegimes(asRecord(snapshot.analysis), savedCeiling, regimes),
    ),
    ceiling: buildPublicSharedCeiling(report.ceiling_snapshot, regimes),
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
    .select(
      "plan_code,status,current_period_end,stripe_customer_id,stripe_subscription_id,metadata",
    )
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  const planActive = Boolean(data && isPlanPeriodActive(data.status, data.current_period_end));
  const plan = data && planActive ? normalizePlanCode(data.plan_code) : "decouverte";
  // Prolongation d'essai par l'administrateur (ligne sans abonnement Stripe) : c'est un essai, pas un
  // abonnement. Même règle que `app_private.is_admin_trial_extension` (migration 20261108130000).
  const extension = isTrialExtensionRow(data);
  if (data && extension && planActive && plan === "analyse") {
    return buildPlanEntitlements(
      "analyse",
      data.current_period_end,
      PLAN_LIMITS.analyse,
      // Pas de portail ni de résiliation : un éventuel client Stripe (checkout abandonné) n'est pas
      // un abonnement à gérer.
      { status: data.status as PlanStatus, hasStripeCustomer: false, graceEndsAt: null },
      { launchOffer: true, trialEndsAt: data.current_period_end, trialExtension: true },
    );
  }
  const extensionEndedAt = data && extension && !planActive ? data.current_period_end : null;
  const billing: PlanBilling = {
    status: (data?.status as PlanStatus | undefined) ?? null,
    hasStripeCustomer: Boolean(data?.stripe_customer_id),
    graceEndsAt: data?.status === "past_due" ? pastDueGraceEnd(data.current_period_end) : null,
  };
  // Essai gratuit de 7 jours à l'inscription : pendant son essai, un compte gratuit qui a un
  // profil reçoit l’offre Analyse, avec ses quotas (rapports, PDF, actualisations). L'état vient de
  // la base, comme pour les fonctions SQL d'accès (`app_private.has_active_analysis_access`) ; rien
  // n'est écrit sur le compte, la fin de l'essai ramène donc le plan Découverte sans nettoyage.
  if (plan === "decouverte" && auth.hasProfile !== false) {
    // Essai lu dans la base (`app_private.signup_trial_ends_at`) : email confirmé, non jetable, plus
    // ancien compte confirmé de son adresse canonique, 7 jours après la confirmation. La lecture
    // applique aussi l'interrupteur : couper l'essai ne ferme que les nouveaux essais.
    const trial = await readSignupTrial(auth.userId);
    if (trial.active) {
      return buildPlanEntitlements(
        "analyse",
        data?.current_period_end ?? null,
        PLAN_LIMITS.analyse,
        billing,
        { launchOffer: true, trialEndsAt: trial.endsAt },
      );
    }
    // Fin de l'essai : la plus tardive de la fin naturelle et de la fin d'une prolongation échue.
    const endedAt = latestIso(trial.endsAt, extensionEndedAt);
    if (endedAt || trial.denied) {
      return buildPlanEntitlements(
        plan,
        data?.current_period_end ?? null,
        PLAN_LIMITS[plan],
        billing,
        { trialEndedAt: endedAt, trialDenied: !endedAt && trial.denied === true },
      );
    }
  }
  return buildPlanEntitlements(plan, data?.current_period_end ?? null, PLAN_LIMITS[plan], billing);
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value || !Number.isFinite(Date.parse(value))) continue;
    if (latest === null || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}

/** The door that opens a right for a sale: the offer itself, or the unlock of this very sale. */
export type SaleFeatureDoor = "plan" | "unlock";

/**
 * Which door opens `feature` for this sale, or null when neither does. The unlock opens only the
 * rights of `SALE_UNLOCK_FEATURES`, for the sale the database confirms (unlocked and still online).
 * Routes use the door to choose what they return: the full read for the offer, the reduced one for
 * an unlock.
 */
export async function saleFeatureDoor(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  saleId: string,
): Promise<SaleFeatureDoor | null> {
  const plan = await resolvePlanEntitlements(auth);
  if (featureIncluded(plan.plan, feature)) return "plan";
  return isSaleUnlockFeature(feature) && (await hasUnlockedSale(auth, saleId)) ? "unlock" : null;
}

/**
 * True when the caller reads `feature` in full for this sale: the offer includes it, or the
 * account unlocked this sale and the right is one an unlock opens. Used by the routes that serve a
 * teaser to the other accounts (document reading, sale history).
 */
export async function featureIncludedForSale(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  saleId: string,
): Promise<boolean> {
  return (await saleFeatureDoor(auth, feature, saleId)) !== null;
}

/**
 * Refuse a right the caller's offer does not include, and say which door opened it.
 *
 * With `saleId`, a Découverte account that unlocked that sale ("3 déblocages par mois") is let
 * through for the rights an unlock opens (`SALE_UNLOCK_FEATURES`), for that sale only: the
 * database confirms the unlock and that the sale is still online. Every other right, and every
 * other sale, stays refused.
 */
export async function assertFeatureEntitlementVia(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  message = "Fonctionnalité réservée à l’offre Analyse.",
  options: { saleId?: string } = {},
): Promise<{ plan: PlanEntitlements; door: SaleFeatureDoor }> {
  const plan = await resolvePlanEntitlements(auth);
  if (featureIncluded(plan.plan, feature)) return { plan, door: "plan" };
  if (
    options.saleId &&
    isSaleUnlockFeature(feature) &&
    (await hasUnlockedSale(auth, options.saleId))
  ) {
    return { plan, door: "unlock" };
  }
  assertEntitlementIncluded(plan, feature, message);
  return { plan, door: "plan" };
}

export async function assertFeatureEntitlement(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  message = "Fonctionnalité réservée à l’offre Analyse.",
  options: { saleId?: string } = {},
): Promise<PlanEntitlements> {
  return (await assertFeatureEntitlementVia(auth, feature, message, options)).plan;
}
