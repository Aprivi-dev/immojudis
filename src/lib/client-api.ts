import { authHeaders, readJson } from "@/lib/client-api-core";
import { ADMIN_PAGE_SIZE } from "@/lib/admin-pagination";
import type {
  AdminDashboardAiData,
  AdminDashboardCountsData,
  AdminDashboardRunsData,
  AdminDashboardSection,
  AdminScrollMode,
  AdminScrollSource,
  StartScrollResult,
} from "@/lib/admin.server";
import type { ApiKeyCreateInput, ApiKeyCreateResponse, ApiKeyListResponse } from "@/lib/api-keys";
import type {
  AdminReferencedLawyerInput,
  AdminReferencedLawyerListResponse,
  AdminReferencedLawyerSaveResponse,
} from "@/lib/admin-lawyers";
import type {
  AdminLawyerReferralListResponse,
  AdminLawyerReferralUpdateInput,
  AdminLawyerReferralUpdateResponse,
} from "@/lib/admin-lawyer-referrals";
import type {
  AdminSubscriptionGrantInput,
  AdminSubscriptionGrantResponse,
  AdminSubscriptionListResponse,
} from "@/lib/admin-subscriptions";
import type { AdminOperationalReadinessResponse } from "@/lib/admin-readiness";
import type {
  AdminCatalogueReadinessAction,
  CatalogueReadinessOverview,
} from "@/lib/admin-catalogue-readiness";
import type {
  AdminAuctionFactClaimDecision,
  AdminAuctionFactClaimReviewResponse,
} from "@/lib/admin-auction-fact-claims-review";
import type {
  AdminInformationAgentReviewInput,
  AdminInformationAgentReviewResponse,
} from "@/lib/admin-information-agent";
import type {
  AdminSourceRefreshRequestInput,
  AdminSourceRefreshResponse,
} from "@/lib/admin-source-refresh";
import type { DataQualityReport } from "@/lib/data-quality-monitor";
import type {
  AdminPublicationQuery,
  AdminPublicationReviewInput,
  AdminPublicationReviewResponse,
  AdminPublicationRequestsResponse,
} from "@/lib/admin-publication-requests";
import type {
  PrivacyRequestAdminListResponse,
  PrivacyRequestAdminSummary,
  PrivacyErasureExecuteInput,
  PrivacyErasureReport,
  PrivacyRequestAdminUpdate,
  PrivacyRequestInput,
  PrivacyRequestListResponse,
  PrivacyRequestSummary,
} from "@/lib/privacy-requests";
import type {
  InformationAgentAdminActionPayload,
  InformationAgentAdminListResponse,
  InformationAgentAdminMissionPage,
  InformationAgentAdminResponse,
  InformationAgentCreateInput,
} from "@/lib/information-agent";
import type {
  InformationAgentEmailTemplateContent,
  InformationAgentEmailTemplatePreview,
  InformationAgentEmailTemplateWorkspace,
} from "@/lib/information-agent-email-template";
import type { PipelineControlSettings, PipelineStatus } from "@/lib/pipeline-status";

export { requestDataRefresh, fetchDataRefreshRequests } from "@/lib/client-api/data-refresh";

export {
  fetchSaleAnalysisSets,
  createSaleAnalysisSet,
  updateSaleAnalysisSet,
  deleteSaleAnalysisSet,
  enableSaleComparisonShare,
  disableSaleComparisonShare,
} from "@/lib/client-api/analysis-sets";

export {
  fetchWatchedZones,
  createWatchedZone,
  updateWatchedZone,
  deleteWatchedZone,
} from "@/lib/client-api/watched-zones";

export {
  fetchSaleWorkspace,
  fetchAudienceTracking,
  saveSaleWorkspace,
  saveProfessionalPilotDossier,
  fetchSaleWorkspaceCollaboration,
  inviteSaleWorkspaceCollaboratorClient,
  acceptSaleWorkspaceInvitationClient,
  createSaleWorkspaceAnnotationClient,
  updateSaleWorkspaceAnnotationClient,
  revokeSaleWorkspaceCollaboratorClient,
} from "@/lib/client-api/sale-workspace";

export {
  fetchAlertMatches,
  evaluateAlertMatches,
  fetchAlertNotifications,
  updateAlertNotification,
  fetchSaleChangeEvents,
  monitorSaleChanges,
  updateSaleChangeEvent,
  fetchNotificationPreferences,
  updateNotificationPreferences,
} from "@/lib/client-api/alerts";

export {
  fetchPropertyReports,
  savePropertyReport,
  updatePropertyReport,
  exportPropertyReportPdf,
  enablePropertyReportShare,
  disablePropertyReportShare,
  fetchFeatureEntitlements,
} from "@/lib/client-api/property-reports";

export {
  requestLawyerReferral,
  fetchLawyerReferrals,
  fetchFeaturedReferencedLawyer,
  fetchLawyerDirectory,
  recordLawyerPlacementEvent,
} from "@/lib/client-api/lawyers";

export {
  fetchFavoriteSales,
  addFavoriteSale,
  removeFavoriteSale,
} from "@/lib/client-api/favorites";

export {
  fetchSalesAiReviewProjections,
  fetchSaleAiReviewProjections,
  fetchSaleFactReliabilities,
  fetchPrecomputedMarketEstimate,
  fetchOutcomeGraphForecast,
  fetchSaleUrbanismeCadastre,
  fetchValuationAdminOverview,
  fetchEnvironmentalContext,
  calculateBidCeilingClient,
  fetchSaleHistory,
  fetchMarketAnalytics,
  fetchDvfComparables,
  fetchValuationBacktest,
  fetchDpeExplorer,
  fetchSalesStatistics,
  exportSalesCsv,
} from "@/lib/client-api/sale-analysis";
export type {
  SaleFactReliabilitiesResponse,
  SaleAiReviewResponse,
} from "@/lib/client-api/sale-analysis";

export { fetchAccessPlan, openBillingPortal, startAnalyseCheckout } from "@/lib/client-billing";

export async function fetchPrivacyRequests(): Promise<PrivacyRequestListResponse> {
  const response = await fetch("/api/privacy/requests", { headers: await authHeaders() });
  return readJson<PrivacyRequestListResponse>(response);
}

export async function createPrivacyRequestClient(
  data: PrivacyRequestInput,
): Promise<PrivacyRequestSummary> {
  const response = await fetch("/api/privacy/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<PrivacyRequestSummary>(response);
}

export async function fetchAdminPrivacyRequests(
  input: { offset?: number; limit?: number } = {},
): Promise<PrivacyRequestAdminListResponse> {
  const search = new URLSearchParams({
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 100),
  });
  const response = await fetch("/api/admin/privacy-requests?" + search.toString(), {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });
  return readJson<PrivacyRequestAdminListResponse>(response);
}

export async function updateAdminPrivacyRequest(
  data: PrivacyRequestAdminUpdate,
): Promise<PrivacyRequestAdminSummary> {
  const response = await fetch("/api/admin/privacy-requests", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<PrivacyRequestAdminSummary>(response);
}

export async function executeAdminContractWithdrawal(data: {
  requestId: string;
  refundMode: "prorata" | "full";
}): Promise<{ refundedCents: number; subscriptionCancelled: boolean }> {
  const response = await fetch("/api/admin/privacy-requests/withdrawal", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<{ refundedCents: number; subscriptionCancelled: boolean }>(response);
}

export async function executeAdminPrivacyErasure(
  data: PrivacyErasureExecuteInput,
): Promise<PrivacyErasureReport> {
  const response = await fetch("/api/admin/privacy-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<PrivacyErasureReport>(response);
}

/**
 * Chaque vue admin ne demande que la section du tableau de bord qu'elle affiche : `runs` est
 * rapide, `ai` lit toutes les synthèses IA, `counts` fait six comptages exacts.
 */
async function fetchAdminDashboardSection<T>(section: AdminDashboardSection): Promise<T> {
  const response = await fetch(`/api/admin/dashboard?section=${section}`, {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });

  return readJson<T>(response);
}

export function fetchAdminDashboardRuns(): Promise<AdminDashboardRunsData> {
  return fetchAdminDashboardSection<AdminDashboardRunsData>("runs");
}

export function fetchAdminDashboardAi(): Promise<AdminDashboardAiData> {
  return fetchAdminDashboardSection<AdminDashboardAiData>("ai");
}

export function fetchAdminDashboardCounts(): Promise<AdminDashboardCountsData> {
  return fetchAdminDashboardSection<AdminDashboardCountsData>("counts");
}

export async function fetchAdminInformationAgentEmailTemplate(): Promise<InformationAgentEmailTemplateWorkspace> {
  const response = await fetch("/api/admin/information-agent/template", {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<InformationAgentEmailTemplateWorkspace>(response);
}

export async function fetchAdminCatalogueReadiness(args?: {
  offset?: number;
  limit?: number;
}): Promise<CatalogueReadinessOverview> {
  const search = new URLSearchParams();
  if (args?.offset != null) search.set("offset", String(args.offset));
  if (args?.limit != null) search.set("limit", String(args.limit));
  const suffix = search.size ? `?${search.toString()}` : "";
  const response = await fetch(`/api/admin/catalogue-readiness${suffix}`, {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<CatalogueReadinessOverview>(response);
}

export async function runAdminCatalogueReadinessActionClient(
  data: AdminCatalogueReadinessAction,
): Promise<CatalogueReadinessOverview> {
  const response = await fetch("/api/admin/catalogue-readiness", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<CatalogueReadinessOverview>(response);
}

export type AdminAuctionFactClaimReviewPageParam = {
  offset?: number;
  limit?: number;
  status?: "candidate" | "conflicted";
};

export async function fetchAdminAuctionFactClaimReview(
  pageParam: AdminAuctionFactClaimReviewPageParam = {},
): Promise<AdminAuctionFactClaimReviewResponse> {
  const search = new URLSearchParams();
  search.set("offset", String(pageParam.offset ?? 0));
  search.set("limit", String(pageParam.limit ?? ADMIN_PAGE_SIZE));
  if (pageParam.status) search.set("status", pageParam.status);
  const response = await fetch(`/api/admin/fact-claims/review?${search.toString()}`, {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<AdminAuctionFactClaimReviewResponse>(response);
}

export async function reviewAdminAuctionFactClaimClient(
  data: AdminAuctionFactClaimDecision,
): Promise<{ ok: true; result: unknown }> {
  const response = await fetch("/api/admin/fact-claims/review", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<{ ok: true; result: unknown }>(response);
}

export async function fetchAdminInformationAgentMissions(args?: {
  saleId?: string;
  offset?: number;
  limit?: number;
}): Promise<InformationAgentAdminMissionPage> {
  const search = new URLSearchParams();
  if (args?.saleId) search.set("saleId", args.saleId);
  search.set("offset", String(args?.offset ?? 0));
  search.set("limit", String(args?.limit ?? ADMIN_PAGE_SIZE));
  const response = await fetch(`/api/admin/information-agent/missions?${search.toString()}`, {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<InformationAgentAdminMissionPage>(response);
}

export async function createAdminInformationAgentMission(
  data: InformationAgentCreateInput,
): Promise<InformationAgentAdminResponse> {
  const response = await fetch("/api/admin/information-agent/missions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<InformationAgentAdminResponse>(response);
}

export async function runAdminInformationAgentMissionAction(
  data: InformationAgentAdminActionPayload,
): Promise<InformationAgentAdminListResponse> {
  const response = await fetch("/api/admin/information-agent/missions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<InformationAgentAdminListResponse>(response);
}

export async function fetchAdminSourceRefreshStatus(
  saleId: string,
): Promise<AdminSourceRefreshResponse> {
  const search = new URLSearchParams({ saleId });
  const response = await fetch(`/api/admin/information-agent/source-refresh?${search.toString()}`, {
    signal: AbortSignal.timeout(15_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<AdminSourceRefreshResponse>(response);
}

export async function requestAdminSourceRefresh(
  data: AdminSourceRefreshRequestInput,
): Promise<AdminSourceRefreshResponse> {
  const response = await fetch("/api/admin/information-agent/source-refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<AdminSourceRefreshResponse>(response);
}

export type AdminInformationAgentReviewPageParam = {
  offset?: number;
  limit?: number;
};

export async function fetchAdminInformationAgentReview(
  pageParam: AdminInformationAgentReviewPageParam = {},
): Promise<AdminInformationAgentReviewResponse> {
  const search = new URLSearchParams();
  search.set("offset", String(pageParam.offset ?? 0));
  search.set("limit", String(pageParam.limit ?? ADMIN_PAGE_SIZE));
  const response = await fetch(`/api/admin/information-agent?${search.toString()}`, {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<AdminInformationAgentReviewResponse>(response);
}

export async function reviewAdminInformationAgentFactClient(
  data: AdminInformationAgentReviewInput,
): Promise<{ ok: true; result: unknown }> {
  const response = await fetch("/api/admin/information-agent", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<{ ok: true; result: unknown }>(response);
}

export type AdminInformationAgentEvidenceRightsStatus = "authorized" | "restricted";

export type AdminInformationAgentEvidenceRightsResponse = {
  ok: true;
  asset: {
    id: string;
    rights_status: AdminInformationAgentEvidenceRightsStatus;
    review_status: "pending" | "accepted" | "rejected";
  };
};

/**
 * Resolve an authenticated admin request to a short-lived private asset URL.
 *
 * The API deliberately keeps the storage object private and returns the
 * short-lived signed URL only to an authenticated admin client. The direct
 * redirect form remains available for server-side or manual callers, while
 * this JSON form avoids browser opaque-redirect behavior.
 */
export async function fetchAdminInformationAgentEvidenceUrlClient(
  assetId: string,
): Promise<string> {
  const response = await fetch(
    `/api/admin/information-agent/evidence/${encodeURIComponent(assetId)}?format=json`,
    {
      headers: await authHeaders(),
      cache: "no-store",
    },
  );

  const payload = await readJson<{ signedUrl?: string }>(response);
  if (!payload.signedUrl) throw new Error("Lien sécurisé de la pièce indisponible.");
  return payload.signedUrl;
}

export async function updateAdminInformationAgentEvidenceRightsClient({
  assetId,
  rightsStatus,
  notes,
}: {
  assetId: string;
  rightsStatus: AdminInformationAgentEvidenceRightsStatus;
  notes: string | null;
}): Promise<AdminInformationAgentEvidenceRightsResponse> {
  const response = await fetch(
    `/api/admin/information-agent/evidence/${encodeURIComponent(assetId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ rightsStatus, notes }),
    },
  );
  return readJson<AdminInformationAgentEvidenceRightsResponse>(response);
}

export async function previewAdminInformationAgentEmailTemplate(
  template: InformationAgentEmailTemplateContent,
): Promise<{ preview: InformationAgentEmailTemplatePreview }> {
  const response = await fetch("/api/admin/information-agent/template", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ action: "preview", template }),
  });
  return readJson<{ preview: InformationAgentEmailTemplatePreview }>(response);
}

export async function saveAdminInformationAgentEmailTemplateDraft(args: {
  draftId: string | null;
  template: InformationAgentEmailTemplateContent;
}): Promise<InformationAgentEmailTemplateWorkspace> {
  const response = await fetch("/api/admin/information-agent/template", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ action: "save_draft", ...args }),
  });
  return readJson<InformationAgentEmailTemplateWorkspace>(response);
}

export async function publishAdminInformationAgentEmailTemplateDraft(
  draftId: string,
): Promise<InformationAgentEmailTemplateWorkspace> {
  const response = await fetch("/api/admin/information-agent/template", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ action: "publish", draftId, publicationConfirmed: true }),
  });
  return readJson<InformationAgentEmailTemplateWorkspace>(response);
}

export async function fetchAdminDataQuality(): Promise<DataQualityReport> {
  const response = await fetch("/api/admin/data-quality", {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });

  return readJson<DataQualityReport>(response);
}

export async function fetchAdminPublicationRequests(
  input: Partial<AdminPublicationQuery> = {},
): Promise<AdminPublicationRequestsResponse> {
  const search = new URLSearchParams();
  search.set("status", input.status ?? "all");
  search.set("search", input.search ?? "");
  search.set("offset", String(input.offset ?? 0));
  search.set("limit", String(input.limit ?? 30));
  const response = await fetch("/api/admin/publications?" + search.toString(), {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<AdminPublicationRequestsResponse>(response);
}

export async function reviewAdminPublicationRequest(
  input: AdminPublicationReviewInput,
): Promise<AdminPublicationReviewResponse> {
  const response = await fetch("/api/admin/publications", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  return readJson<AdminPublicationReviewResponse>(response);
}

export async function startAdminScrollRequest(args: {
  data: { source: AdminScrollSource; mode?: AdminScrollMode; limit?: number };
}): Promise<StartScrollResult> {
  const response = await fetch("/api/admin/scroll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<StartScrollResult>(response);
}

export async function fetchAdminReadiness(): Promise<AdminOperationalReadinessResponse> {
  const response = await fetch("/api/admin/readiness", {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });

  return readJson<AdminOperationalReadinessResponse>(response);
}

export async function fetchAdminReferencedLawyers(): Promise<AdminReferencedLawyerListResponse> {
  const response = await fetch("/api/admin/lawyers", {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });

  return readJson<AdminReferencedLawyerListResponse>(response);
}

export async function saveAdminReferencedLawyer(args: {
  data: AdminReferencedLawyerInput;
}): Promise<AdminReferencedLawyerSaveResponse> {
  const response = await fetch("/api/admin/lawyers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<AdminReferencedLawyerSaveResponse>(response);
}

export async function fetchAdminLawyerReferralRequests(
  input: { offset?: number; limit?: number } = {},
): Promise<AdminLawyerReferralListResponse> {
  const search = new URLSearchParams({
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 50),
  });
  const response = await fetch("/api/admin/lawyer-referrals?" + search.toString(), {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });

  return readJson<AdminLawyerReferralListResponse>(response);
}

export async function updateAdminLawyerReferralRequest(args: {
  data: AdminLawyerReferralUpdateInput;
}): Promise<AdminLawyerReferralUpdateResponse> {
  const response = await fetch("/api/admin/lawyer-referrals", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<AdminLawyerReferralUpdateResponse>(response);
}

export async function fetchAdminSubscriptions(
  input: { offset?: number; limit?: number } = {},
): Promise<AdminSubscriptionListResponse> {
  const search = new URLSearchParams({
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 50),
  });
  const response = await fetch("/api/admin/subscriptions?" + search.toString(), {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });

  return readJson<AdminSubscriptionListResponse>(response);
}

export async function grantAdminSubscription(args: {
  data: AdminSubscriptionGrantInput;
}): Promise<AdminSubscriptionGrantResponse> {
  const response = await fetch("/api/admin/subscriptions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<AdminSubscriptionGrantResponse>(response);
}

export async function fetchApiKeys(): Promise<ApiKeyListResponse> {
  const response = await fetch("/api/api-keys", {
    headers: await authHeaders(),
  });

  return readJson<ApiKeyListResponse>(response);
}

export async function createApiKey(args: {
  data: ApiKeyCreateInput;
}): Promise<ApiKeyCreateResponse> {
  const response = await fetch("/api/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<ApiKeyCreateResponse>(response);
}

export async function revokeApiKey(args: { keyId: string }): Promise<void> {
  const response = await fetch(`/api/api-keys/${encodeURIComponent(args.keyId)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  await readJson<{ key: unknown }>(response);
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  return readJson(
    await fetch("/api/admin/pipeline", {
      signal: AbortSignal.timeout(30_000),
      headers: await authHeaders(),
      cache: "no-store",
    }),
  );
}
export async function setPipelineSourceEnabled(source: string, enabled: boolean): Promise<void> {
  await readJson(
    await fetch("/api/admin/pipeline", {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({ source, enabled }),
    }),
  );
}

export async function updatePipelineControl(
  changes: Partial<PipelineControlSettings>,
): Promise<PipelineStatus["control"]> {
  const response = await fetch("/api/admin/pipeline/control", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(changes),
    signal: AbortSignal.timeout(10_000),
  });

  return readJson<PipelineStatus["control"]>(response);
}
