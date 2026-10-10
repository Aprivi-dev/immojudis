import { authHeaders, readJson } from "@/lib/client-api-core";
import { ADMIN_PAGE_SIZE } from "@/lib/admin-pagination";
import type { AudienceTrackingResponse } from "@/lib/audience-tracking";
import type {
  AlertNotificationListResponse,
  AlertNotificationSummary,
} from "@/lib/alert-notifications";
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
import type { AlertEvaluationResponse, AlertMatchSummary } from "@/lib/alert-matches";
import type {
  NotificationPreferencesResponse,
  NotificationPreferenceUpdateInput,
} from "@/lib/notification-preferences";
import type {
  PropertyReportListResponse,
  PropertyReportRequestInput,
  PropertyReportSaveResponse,
  PropertyReportShareResponse,
  PropertyReportUpdateInput,
  PlanEntitlements,
} from "@/lib/property-reports";
import type {
  DataRefreshListResponse,
  DataRefreshRequestInput,
  DataRefreshRequestResponse,
} from "@/lib/data-refresh";
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
  SaleChangeEventListResponse,
  SaleChangeEventSummary,
  SaleChangeMonitorResponse,
} from "@/lib/sale-change-monitor";
import type {
  CollaboratorAcceptInput,
  CollaboratorInviteInput,
  CollaboratorRevokeInput,
  SaleWorkspaceCollaborationResponse,
  WorkspaceAnnotationCreateInput,
  WorkspaceAnnotationUpdateInput,
} from "@/lib/sale-workspace-collaboration";
import type {
  ProfessionalPilotSaveInput,
  SaleWorkspaceInput,
  SaleWorkspaceResponse,
} from "@/lib/sale-workspaces";
import type {
  SaleAnalysisSetInput,
  SaleAnalysisSetListResponse,
  SaleAnalysisSetResponse,
  SaleAnalysisSetUpdateInput,
  SaleComparisonShareResponse,
} from "@/lib/sale-analysis-sets";
import type { PlanUsageSummary } from "@/lib/usage";
import type {
  WatchedZoneInput,
  WatchedZoneResponse,
  WatchedZonesResponse,
  WatchedZoneUpdateInput,
} from "@/lib/watched-zones";
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

export async function fetchPropertyReports(
  args: {
    saleId?: string;
  } = {},
): Promise<PropertyReportListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  const url = `/api/property-reports${search.size ? `?${search.toString()}` : ""}`;

  const response = await fetch(url, {
    headers: await authHeaders(),
  });

  return readJson<PropertyReportListResponse>(response);
}

export async function savePropertyReport(args: {
  data: PropertyReportRequestInput;
}): Promise<PropertyReportSaveResponse> {
  const response = await fetch("/api/property-reports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<PropertyReportSaveResponse>(response);
}

export async function updatePropertyReport(args: {
  reportId: string;
  data: PropertyReportUpdateInput;
}): Promise<PropertyReportSaveResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<PropertyReportSaveResponse>(response);
}

export async function exportPropertyReportPdf(args: {
  reportId: string;
}): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/property-reports/${args.reportId}/export`, {
    method: "POST",
    headers: await authHeaders(),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  const filename =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1]
      ?.trim() || "rapport-immojudis.pdf";

  return {
    blob: await response.blob(),
    filename,
  };
}

export async function enablePropertyReportShare(args: {
  reportId: string;
  expiresAt?: string | null;
}): Promise<PropertyReportShareResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ expiresAt: args.expiresAt ?? null }),
  });

  return readJson<PropertyReportShareResponse>(response);
}

export async function disablePropertyReportShare(args: {
  reportId: string;
}): Promise<PropertyReportShareResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<PropertyReportShareResponse>(response);
}

export async function fetchFeatureEntitlements(): Promise<{
  plan: PlanEntitlements;
  usage: PlanUsageSummary;
}> {
  const response = await fetch("/api/feature-entitlements", {
    headers: await authHeaders(),
    cache: "no-store",
  });

  return readJson<{ plan: PlanEntitlements; usage: PlanUsageSummary }>(response);
}

export async function fetchAlertMatches(
  args: {
    limit?: number;
    includeDismissed?: boolean;
  } = {},
): Promise<{ matches: AlertMatchSummary[] }> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  const response = await fetch(`/api/alerts/matches${search.size ? `?${search.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<{ matches: AlertMatchSummary[] }>(response);
}

export async function evaluateAlertMatches(
  args: {
    saleLimit?: number;
    persist?: boolean;
  } = {},
): Promise<AlertEvaluationResponse> {
  const response = await fetch("/api/alerts/matches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<AlertEvaluationResponse>(response);
}

export async function fetchAlertNotifications(
  args: {
    limit?: number;
    includeDismissed?: boolean;
    includeQueued?: boolean;
  } = {},
): Promise<AlertNotificationListResponse> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  if (args.includeQueued) search.set("includeQueued", "true");

  const response = await fetch(
    `/api/alerts/notifications${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<AlertNotificationListResponse>(response);
}

export async function updateAlertNotification(args: {
  notificationId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ notification: AlertNotificationSummary }> {
  const response = await fetch("/api/alerts/notifications", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<{ notification: AlertNotificationSummary }>(response);
}

export async function fetchSaleChangeEvents(
  args: {
    limit?: number;
    includeDismissed?: boolean;
  } = {},
): Promise<SaleChangeEventListResponse> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  const response = await fetch(
    `/api/sale-change-events${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SaleChangeEventListResponse>(response);
}

export async function monitorSaleChanges(): Promise<SaleChangeMonitorResponse> {
  const response = await fetch("/api/sale-change-events", {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<SaleChangeMonitorResponse>(response);
}

export async function updateSaleChangeEvent(args: {
  eventId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ event: SaleChangeEventSummary }> {
  const response = await fetch("/api/sale-change-events", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<{ event: SaleChangeEventSummary }>(response);
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  const response = await fetch("/api/notification-preferences", {
    headers: await authHeaders(),
  });

  return readJson<NotificationPreferencesResponse>(response);
}

export async function updateNotificationPreferences(
  data: NotificationPreferenceUpdateInput,
): Promise<NotificationPreferencesResponse> {
  const response = await fetch("/api/notification-preferences", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(data),
  });

  return readJson<NotificationPreferencesResponse>(response);
}

export async function fetchSaleWorkspace(args: { saleId: string }): Promise<SaleWorkspaceResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/sale-workspace?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleWorkspaceResponse>(response);
}

export async function fetchAudienceTracking(
  args: {
    includeArchived?: boolean;
  } = {},
): Promise<AudienceTrackingResponse> {
  const search = new URLSearchParams();
  if (args.includeArchived) search.set("includeArchived", "true");
  const response = await fetch(
    `/api/audience-tracking${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<AudienceTrackingResponse>(response);
}

export async function saveSaleWorkspace(args: {
  data: SaleWorkspaceInput;
}): Promise<SaleWorkspaceResponse> {
  const response = await fetch("/api/sale-workspace", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleWorkspaceResponse>(response);
}

export async function saveProfessionalPilotDossier(
  data: ProfessionalPilotSaveInput,
): Promise<SaleWorkspaceResponse> {
  const response = await fetch("/api/sale-workspace/professional-pilot", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(data),
  });
  return readJson<SaleWorkspaceResponse>(response);
}

export async function fetchSaleWorkspaceCollaboration(args: {
  saleId: string;
}): Promise<SaleWorkspaceCollaborationResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/sale-workspace/collaboration?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleWorkspaceCollaborationResponse>(response);
}

export async function inviteSaleWorkspaceCollaboratorClient(args: {
  data: CollaboratorInviteInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "invite", data: args.data }),
  });

  return readJson(response);
}

export async function acceptSaleWorkspaceInvitationClient(args: { data: CollaboratorAcceptInput }) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "accept", data: args.data }),
  });

  return readJson(response);
}

export async function createSaleWorkspaceAnnotationClient(args: {
  data: WorkspaceAnnotationCreateInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "annotate", data: args.data }),
  });

  return readJson(response);
}

export async function updateSaleWorkspaceAnnotationClient(args: {
  data: WorkspaceAnnotationUpdateInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "update_annotation", data: args.data }),
  });

  return readJson(response);
}

export async function revokeSaleWorkspaceCollaboratorClient(args: {
  data: CollaboratorRevokeInput;
}) {
  const response = await fetch("/api/sale-workspace/collaboration", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ action: "revoke", data: args.data }),
  });

  return readJson(response);
}

export async function fetchWatchedZones(
  args: {
    includeInactive?: boolean;
  } = {},
): Promise<WatchedZonesResponse> {
  const search = new URLSearchParams();
  if (args.includeInactive) search.set("includeInactive", "true");
  const response = await fetch(`/api/watched-zones${search.size ? `?${search.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<WatchedZonesResponse>(response);
}

export async function createWatchedZone(args: {
  data: WatchedZoneInput;
}): Promise<WatchedZoneResponse> {
  const response = await fetch("/api/watched-zones", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<WatchedZoneResponse>(response);
}

export async function updateWatchedZone(args: {
  zoneId: string;
  data: WatchedZoneUpdateInput;
}): Promise<WatchedZoneResponse> {
  const response = await fetch(`/api/watched-zones/${args.zoneId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<WatchedZoneResponse>(response);
}

export async function deleteWatchedZone(args: { zoneId: string }): Promise<{ ok: true }> {
  const response = await fetch(`/api/watched-zones/${args.zoneId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<{ ok: true }>(response);
}

export async function fetchSaleAnalysisSets(
  args: {
    includeArchived?: boolean;
  } = {},
): Promise<SaleAnalysisSetListResponse> {
  const search = new URLSearchParams();
  if (args.includeArchived) search.set("includeArchived", "true");
  const response = await fetch(
    `/api/sale-analysis-sets${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SaleAnalysisSetListResponse>(response);
}

export async function createSaleAnalysisSet(args: {
  data: SaleAnalysisSetInput;
}): Promise<SaleAnalysisSetResponse> {
  const response = await fetch("/api/sale-analysis-sets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleAnalysisSetResponse>(response);
}

export async function updateSaleAnalysisSet(args: {
  setId: string;
  data: SaleAnalysisSetUpdateInput;
}): Promise<SaleAnalysisSetResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleAnalysisSetResponse>(response);
}

export async function deleteSaleAnalysisSet(args: { setId: string }): Promise<{ ok: true }> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<{ ok: true }>(response);
}

export async function enableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<SaleComparisonShareResponse>(response);
}

export async function disableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<SaleComparisonShareResponse>(response);
}

export async function requestDataRefresh(
  input: DataRefreshRequestInput,
): Promise<DataRefreshRequestResponse> {
  const response = await fetch("/api/data-refresh", {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return readJson<DataRefreshRequestResponse>(response);
}

export async function fetchDataRefreshRequests(
  args: {
    saleId?: string;
    status?: string;
  } = {},
): Promise<DataRefreshListResponse> {
  const params = new URLSearchParams();
  if (args.saleId) params.set("saleId", args.saleId);
  if (args.status) params.set("status", args.status);
  const response = await fetch(`/api/data-refresh${params.size ? `?${params.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<DataRefreshListResponse>(response);
}

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
