export {
  fetchPipelineStatus,
  setPipelineSourceEnabled,
  updatePipelineControl,
} from "@/lib/client-api/pipeline";

export { fetchApiKeys, createApiKey, revokeApiKey } from "@/lib/client-api/api-keys";

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
