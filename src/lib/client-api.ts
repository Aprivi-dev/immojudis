import { authHeaders, readJson } from "@/lib/client-api-core";
import type { ApiKeyCreateInput, ApiKeyCreateResponse, ApiKeyListResponse } from "@/lib/api-keys";
import type { PipelineControlSettings, PipelineStatus } from "@/lib/pipeline-status";

export {
  fetchAdminInformationAgentEmailTemplate,
  fetchAdminCatalogueReadiness,
  runAdminCatalogueReadinessActionClient,
  fetchAdminAuctionFactClaimReview,
  reviewAdminAuctionFactClaimClient,
  fetchAdminInformationAgentMissions,
  createAdminInformationAgentMission,
  runAdminInformationAgentMissionAction,
  fetchAdminSourceRefreshStatus,
  requestAdminSourceRefresh,
  fetchAdminInformationAgentReview,
  reviewAdminInformationAgentFactClient,
  fetchAdminInformationAgentEvidenceUrlClient,
  updateAdminInformationAgentEvidenceRightsClient,
  previewAdminInformationAgentEmailTemplate,
  saveAdminInformationAgentEmailTemplateDraft,
  publishAdminInformationAgentEmailTemplateDraft,
} from "@/lib/client-api/admin-information-agent";
export type {
  AdminAuctionFactClaimReviewPageParam,
  AdminInformationAgentReviewPageParam,
  AdminInformationAgentEvidenceRightsStatus,
  AdminInformationAgentEvidenceRightsResponse,
} from "@/lib/client-api/admin-information-agent";

export {
  fetchAdminDashboardRuns,
  fetchAdminDashboardAi,
  fetchAdminDashboardCounts,
  fetchAdminDataQuality,
  fetchAdminPublicationRequests,
  reviewAdminPublicationRequest,
  startAdminScrollRequest,
  fetchAdminReadiness,
  fetchAdminReferencedLawyers,
  saveAdminReferencedLawyer,
  fetchAdminLawyerReferralRequests,
  updateAdminLawyerReferralRequest,
  fetchAdminSubscriptions,
  grantAdminSubscription,
} from "@/lib/client-api/admin";

export {
  fetchPrivacyRequests,
  createPrivacyRequestClient,
  fetchAdminPrivacyRequests,
  updateAdminPrivacyRequest,
  executeAdminContractWithdrawal,
  executeAdminPrivacyErasure,
} from "@/lib/client-api/privacy";

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
