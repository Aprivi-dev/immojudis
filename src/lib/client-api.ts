export {
  fetchPipelineStatus,
  setPipelineSourceEnabled,
  updatePipelineControl,
} from "@/lib/client-api/pipeline";

export {
  fetchAdminInformationAgentEmailTemplate,
  fetchAdminInformationAgentOperations,
  fetchAdminInformationAgentAutopilot,
  runAdminInformationAgentAutopilotActionClient,
  attestAdminInformationAgentRoundtripClient,
  fetchAdminCatalogueReadiness,
  runAdminCatalogueReadinessActionClient,
  fetchAdminAuctionFactClaimReview,
  reviewAdminAuctionFactClaimClient,
  fetchAdminInformationAgentMissions,
  createAdminInformationAgentMission,
  runAdminInformationAgentMissionAction,
  previewAdminInformationAgentMission,
  fetchAdminSourceRefreshStatus,
  requestAdminSourceRefresh,
  fetchAdminInformationAgentReview,
  reviewAdminInformationAgentFactClient,
  runAdminInformationAgentMessageActionClient,
  fetchAdminInformationAgentUnrouted,
  markAdminInformationAgentUnroutedHandledClient,
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
  fetchAdminLaunchOffer,
  setAdminLaunchOfferClient,
  fetchAdminOfferOpeningAudience,
  sendAdminOfferOpeningTest,
  sendAdminOfferOpeningBatch,
} from "@/lib/client-api/admin";

export {
  fetchPrivacyRequests,
  createPrivacyRequestClient,
  fetchAdminPrivacyRequests,
  updateAdminPrivacyRequest,
  executeAdminContractWithdrawal,
  executeAdminPrivacyErasure,
  fetchAdminProfessionalPrivacyExport,
} from "@/lib/client-api/privacy";

export {
  fetchSaleAnalysisSets,
  createSaleAnalysisSet,
  deleteSaleAnalysisSet,
  enableSaleComparisonShare,
  disableSaleComparisonShare,
} from "@/lib/client-api/analysis-sets";

export {
  fetchWatchedZones,
  createWatchedZone,
  deleteWatchedZone,
} from "@/lib/client-api/watched-zones";

export { fetchSaleWorkspace, saveProfessionalPilotDossier } from "@/lib/client-api/sale-workspace";

export {
  fetchInvestorProfile,
  saveInvestorProfile,
  deleteInvestorProfile,
} from "@/lib/client-api/investor-profile";

export {
  evaluateAlertMatches,
  fetchAlertNotifications,
  updateAlertNotification,
  fetchSaleChangeEvents,
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
} from "@/lib/client-api/property-reports";

export {
  requestLawyerReferral,
  fetchLawyerReferrals,
  fetchLawyerReferralPreview,
  fetchLawyerDirectory,
  fetchLawyerProsecutedSales,
} from "@/lib/client-api/lawyers";

export {
  fetchFavoriteSales,
  addFavoriteSale,
  removeFavoriteSale,
  fetchFavoriteDossier,
  saveFavoriteDossier,
  fetchFollowedSaleSnapshots,
  deleteFollowedSaleSnapshot,
  updateFollowedSaleSnapshot,
  downloadFollowedCalendar,
  downloadSnapshotDeadlines,
} from "@/lib/client-api/favorites";

export {
  fetchSalesAiReviewProjections,
  fetchSaleAiReviewProjections,
  fetchSaleFactReliabilities,
  fetchPrecomputedMarketEstimate,
  fetchDocumentReading,
  fetchSaleUnlockStatus,
  fetchSaleUnlocksOverview,
  unlockSaleRequest,
  SaleUnlockQuotaReachedError,
  fetchSalePassages,
  fetchAuctionScenarios,
  fetchCourtAuctionSummaries,
  fetchValuePreview,
  fetchOutcomeGraphForecast,
  fetchSaleUrbanismeCadastre,
  fetchValuationAdminOverview,
  fetchDpeExplorer,
  fetchSalesStatistics,
  exportSalesCsv,
} from "@/lib/client-api/sale-analysis";
export type {
  SaleFactReliabilitiesResponse,
  SaleAiReviewResponse,
} from "@/lib/client-api/sale-analysis";

export { fetchAccessPlan, openBillingPortal, startAnalyseCheckout } from "@/lib/client-billing";
