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
  featureIncluded,
  isPlanPeriodActive,
  normalizePlanCode,
  type FeatureKey,
  type PlanEntitlements,
} from "@/lib/plans";
import { enforceDailyOperationLimits } from "@/lib/rate-limit";
import { createTextPdf } from "@/lib/simple-pdf";
import { REPORT_COMPLIANCE_NOTICE, type SourceTraceEntry } from "@/lib/source-traceability";
import { hasActiveSignupTrial } from "@/lib/launch-offer.server";
import {
  assertFeatureEntitlementVia,
  getSaleForDoor,
  resolvePlanEntitlements,
  type SaleFeatureDoor,
} from "@/lib/entitlements.server";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { getPublicationVisibleSaleIds } from "@/lib/sale-publication-guard";
import { DETAIL_VIEW, DISCOVERY_VIEW } from "@/lib/sale-views";
import type { AuctionSale } from "@/lib/types";
import { buildMarketSnapshot, buildReportSnapshot } from "./property-report/analysis";
import { buildCeilingSnapshot } from "./property-report/ceiling-snapshot";
import {
  assertEntitlementIncluded,
  buildPlanEntitlements,
  emptyActiveComparableSales,
  featureOpenFor,
  planForSaleDoor,
  sanitizeReportSnapshotForPlan,
  urbanPlanningSignalsForDoor,
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
  getReportSaleId,
  getSale,
  getUrbanPlanningSignals,
  getValuationBacktestForReport,
  recordPdfExport,
} from "./property-report/repository";
import {
  attachPlan,
  defaultReportTitle,
  emptyToNull,
  normalizeShareExpiresAt,
  normalizeSourceTrace,
  normalizeStringList,
  pdfWatermarkForPlan,
  reportPdfIdentity,
  saleLocation,
  shareIsExpired,
} from "./property-report/serialization";
import { createShareToken, hashShareToken, normalizeShareToken } from "@/lib/share-token";
import { asRecord, numberValue, stringOrNumberValue, stringValue } from "@/lib/guards";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";
import { asJson } from "@/lib/supabase-json";
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

type PublicSharedCeiling = {
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
  /** Date de calcul de l'analyse (`report_snapshot.generatedAt`) ; `null` : rapport sans cette date. */
  generatedAt: string | null;
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

export async function listPropertyReports({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId?: string | null;
}): Promise<PropertyReportListResponse> {
  // With a sale, its unlock opens its reports; without, only the offer lists every report.
  const { plan, door } = await assertFeatureEntitlementVia(
    auth,
    "property.savedReports",
    REPORTS_RESERVED_MESSAGE,
    { saleId: saleId ?? undefined },
  );
  const salePlan = planForSaleDoor(plan, door);
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
      .filter((report) => visibleSaleIds.has(report.sale_id) && reportOpenThrough(report, door))
      .map((report) => attachPlan(report, salePlan)),
    plan: salePlan,
  };
}

const REPORTS_RESERVED_MESSAGE = "Rapports réservés à l’offre Analyse.";

/**
 * Through the unlock of its sale, a report is served only when it was built through that unlock
 * (`door: "unlock"` in its snapshot: no score, no risk, no source). One built with the offer (during a
 * trial, for instance) carries what the unlock does not open: it has to be saved again.
 */
function reportOpenThrough(report: Pick<SavedReportRow, "report_snapshot">, door: SaleFeatureDoor) {
  return door === "plan" || asRecord(report.report_snapshot).door === "unlock";
}

/**
 * The right `feature` on an owned report. Without the offer, the report's sale is read before the
 * right is decided, so that the unlock of that sale opens it. A report the session cannot read
 * (another account's, or a Découverte account's before the policy of `saved_property_reports` follows
 * the unlock) is « introuvable ».
 */
async function reportAccess(
  auth: SupabaseAuthContext,
  reportId: string,
  feature: "property.savedReports" | "property.reportEditing" | "property.pdfExport",
  message: string,
): Promise<{ plan: PlanEntitlements; door: SaleFeatureDoor }> {
  return assertFeatureEntitlementVia(auth, feature, message, {
    saleId: () => getReportSaleId(auth.supabase, auth.userId, reportId),
  });
}

/** The owned report, publication-checked, refused through an unlock when not built through it. */
async function getReportThrough(
  auth: SupabaseAuthContext,
  reportId: string,
  door: SaleFeatureDoor,
): Promise<SavedReportRow> {
  const report = await getReport(auth.supabase, auth.userId, reportId);
  if (!reportOpenThrough(report, door)) {
    throw new PublicApiError(
      "Ce rapport a été établi avec l’offre Analyse : enregistrez à nouveau votre analyse depuis la fiche de la vente pour l’ouvrir avec ce déblocage.",
      409,
    );
  }
  return report;
}

export async function getPropertyReport({
  auth,
  reportId,
}: {
  auth: SupabaseAuthContext;
  reportId: string;
}): Promise<PropertyReportDetailResponse> {
  const { plan, door } = await reportAccess(
    auth,
    reportId,
    "property.savedReports",
    REPORTS_RESERVED_MESSAGE,
  );
  const report = await getReportThrough(auth, reportId, door);
  const salePlan = planForSaleDoor(plan, door);

  return {
    report: attachPlan(report, salePlan),
    plan: salePlan,
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
  // The offer, or the unlock of this sale (« déblocage du compte gratuit »).
  const { plan, door } = await assertFeatureEntitlementVia(
    auth,
    "property.savedReports",
    REPORTS_RESERVED_MESSAGE,
    { saleId: input.saleId },
  );
  const open = (feature: FeatureKey) => featureOpenFor(plan, door, feature);
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

  // Through an unlock, the sale comes without what the unlock does not open (score, risks, sources);
  // the enrichment key stays on the server.
  const { sale, enrichmentKey } = await getSaleForDoor(auth, input.saleId, door);
  const valuationConflict = listingValuationConflict(sale);
  if (valuationConflict) throw new Error(valuationConflict);
  const marketEstimatePromise = buildMarketSnapshot(sale);
  const environmentalContextPromise =
    input.includeEnvironment && open("property.neighborhoodAnalysis")
      ? getEnvironmentalContext({
          address: saleLocation(sale),
          lat: sale.latitude,
          lng: sale.longitude,
        })
      : Promise.resolve(null);
  // The other sales are read as the account sees them: in full with the offer, in the redacted
  // catalogue view through an unlock (never the full rows of other sales).
  const activeComparablesPromise = open("property.activeComparables")
    ? getActiveComparableSales(auth.supabase, sale, door === "plan" ? DETAIL_VIEW : DISCOVERY_VIEW)
    : Promise.resolve(emptyActiveComparableSales());
  const cadastreParcelsPromise = getCadastralParcels(enrichmentKey);
  const dpeDiagnosticsPromise = getDpeDiagnostics(enrichmentKey);
  const urbanPlanningSignalsPromise = open("property.urbanPlanning")
    ? getUrbanPlanningSignals(enrichmentKey).then((signals) =>
        urbanPlanningSignalsForDoor(signals, door),
      )
    : Promise.resolve([]);
  const valuationBacktestPromise = open("property.soldComparables")
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
      door,
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
    recordFeatureUsageEvent({
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

  const salePlan = planForSaleDoor(plan, door);
  return {
    report: attachPlan(data, salePlan),
    plan: salePlan,
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
  // Resolve and publication-check the owned report before returning its
  // snapshot through the privileged update client.
  const { plan, door } = await reportAccess(
    auth,
    reportId,
    "property.reportEditing",
    "Édition des rapports réservée à l’offre Analyse.",
  );
  await getReportThrough(auth, reportId, door);
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

  const salePlan = planForSaleDoor(plan, door);
  return {
    report: attachPlan(data, salePlan),
    plan: salePlan,
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
  const { plan, door } = await reportAccess(
    auth,
    reportId,
    "property.pdfExport",
    "Export PDF réservé à l’offre Analyse.",
  );
  await enforceDailyOperationLimits({
    request,
    userId: auth.userId,
    operation: "propertyReportPdf",
    launchOffer: plan.launchOffer === true,
  });
  const report = await getReportThrough(auth, reportId, door);
  // Compared with the sale as this door reads it: the one the report was built from.
  const { sale } = await getSaleForDoor(auth, report.sale_id, door);
  assertReportSourceCurrent(report.report_snapshot, sale);
  const lines = reportToPdfLines(report, plan, openFeeRegimesFromEnv(), door);
  const { title, filename } = reportPdfIdentity(report);
  const bytes = createTextPdf({
    title,
    lines,
    headings: REPORT_PDF_HEADINGS,
    // Le régime vient du plafond enregistré : un rapport notarial par offres ne parle pas d'enchère.
    footer: reportWording(asRecord(report.ceiling_snapshot).regime).footerSentence,
    watermark: pdfWatermarkForPlan(plan),
  });

  await recordPdfExport(auth, report);

  return {
    bytes,
    filename,
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
  if (!normalized) throw new NotFoundError("Lien de partage invalide.");

  const { data, error } = await supabaseAdmin
    .from("saved_property_reports")
    .select(
      "id,user_id,sale_id,title,report_kind,report_snapshot,market_snapshot,environmental_snapshot,ceiling_snapshot,share_enabled,shared_at,share_expires_at,share_view_count,updated_at",
    )
    .eq("share_token_hash", hashShareToken(normalized))
    .eq("share_enabled", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Rapport partagé introuvable ou expiré.");
  // Lien connu mais fermé (échéance, fin de l'essai du propriétaire) : la page l'explique.
  if (shareIsExpired(data.share_expires_at)) throw new SharedReportUnavailableError("expired");
  // A link stops working as soon as its owner no longer has an active Analyse plan.
  if (!(await shareOwnerKeepsSavedReports(data.user_id))) {
    throw new SharedReportUnavailableError("owner_plan_ended");
  }

  assertReportSourceCurrent(data.report_snapshot, await getSale(supabaseAdmin, data.sale_id));

  if (countView) {
    // Incrément atomique en base : deux visiteurs simultanés comptent deux vues. Un échec du
    // compteur ne doit pas empêcher d'afficher le rapport.
    const { data: nextViewCount, error: countError } = await supabaseAdmin.rpc(
      "increment_property_report_share_view",
      { p_report_id: data.id },
    );
    if (countError) {
      console.warn(
        JSON.stringify({
          scope: "property-reports.share",
          event: "view_count_failed",
          message: String(countError.message ?? "").slice(0, 200),
        }),
      );
    } else if (typeof nextViewCount === "number") {
      data.share_view_count = nextViewCount;
    }
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
  return featureIncluded(plan, "property.savedReports");
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
  // A shared link is the offer's alone (`shareOwnerKeepsSavedReports`): never read through an unlock.
  const snapshot = sanitizeReportSnapshotForPlan(
    rawSnapshot,
    buildPlanEntitlements(normalizePlanCode(rawSnapshot.plan)),
    "plan",
  );
  const traceability = asRecord(snapshot.sourceTraceability);
  const savedCeiling = asRecord(report.ceiling_snapshot);

  // Lecture publique par lien : un rapport figé avant le durcissement du filtre est refiltré ici.
  return {
    id: report.id,
    title: redactPersonalText(report.title),
    reportKind: report.report_kind,
    updatedAt: report.updated_at,
    generatedAt: stringValue(snapshot.generatedAt) ?? stringValue(traceability.generatedAt),
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
