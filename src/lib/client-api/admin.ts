import { apiRequest } from "@/lib/client-api-core";
import type {
  AdminDashboardCountsData,
  AdminDashboardRunsData,
  AdminDashboardSection,
  AdminScrollMode,
  AdminScrollSource,
  StartScrollResult,
} from "@/lib/admin.server";
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
import type { AdminLaunchOfferState } from "@/lib/admin-launch-offer";
import type {
  OfferOpeningAudience,
  OfferOpeningSendResult,
  OfferOpeningTestResult,
} from "@/lib/admin-offer-opening-notifier";
import type { OfferOpeningInterviewees } from "@/lib/admin-offer-opening-survey";
import type { AdminPilotageResponse } from "@/lib/admin-pilotage";
import type { LawyerStatement } from "@/lib/lawyer-statement";
import type {
  AdminSubscriptionGrantInput,
  AdminSubscriptionGrantResponse,
  AdminSubscriptionListResponse,
} from "@/lib/admin-subscriptions";
import type { AdminOperationalReadinessResponse } from "@/lib/admin-readiness";
import type { DataQualityReport } from "@/lib/data-quality-monitor";
import type {
  AdminPublicationQuery,
  AdminPublicationReviewInput,
  AdminPublicationReviewResponse,
  AdminPublicationRequestsResponse,
} from "@/lib/admin-publication-requests";

/**
 * Chaque vue admin ne demande que la section du tableau de bord qu'elle affiche : `runs` est
 * rapide, `counts` fait six comptages exacts.
 */
function fetchAdminDashboardSection<T>(section: AdminDashboardSection): Promise<T> {
  return apiRequest<T>(`/api/admin/dashboard?section=${section}`);
}

export function fetchAdminDashboardRuns(): Promise<AdminDashboardRunsData> {
  return fetchAdminDashboardSection<AdminDashboardRunsData>("runs");
}

export function fetchAdminDashboardCounts(): Promise<AdminDashboardCountsData> {
  return fetchAdminDashboardSection<AdminDashboardCountsData>("counts");
}

export function fetchAdminDataQuality(): Promise<DataQualityReport> {
  return apiRequest<DataQualityReport>("/api/admin/data-quality");
}

export function fetchAdminPublicationRequests(
  input: Partial<AdminPublicationQuery> = {},
): Promise<AdminPublicationRequestsResponse> {
  const search = new URLSearchParams();
  search.set("status", input.status ?? "all");
  search.set("search", input.search ?? "");
  search.set("offset", String(input.offset ?? 0));
  search.set("limit", String(input.limit ?? 30));
  return apiRequest<AdminPublicationRequestsResponse>(
    "/api/admin/publications?" + search.toString(),
  );
}

export function reviewAdminPublicationRequest(
  input: AdminPublicationReviewInput,
): Promise<AdminPublicationReviewResponse> {
  return apiRequest<AdminPublicationReviewResponse>("/api/admin/publications", {
    method: "PATCH",
    body: input,
  });
}

export function startAdminScrollRequest(args: {
  data: { source: AdminScrollSource; mode?: AdminScrollMode; limit?: number };
}): Promise<StartScrollResult> {
  return apiRequest<StartScrollResult>("/api/admin/scroll", { method: "POST", body: args.data });
}

export function fetchAdminReadiness(): Promise<AdminOperationalReadinessResponse> {
  return apiRequest<AdminOperationalReadinessResponse>("/api/admin/readiness");
}

export function fetchAdminReferencedLawyers(): Promise<AdminReferencedLawyerListResponse> {
  return apiRequest<AdminReferencedLawyerListResponse>("/api/admin/lawyers");
}

export function saveAdminReferencedLawyer(args: {
  data: AdminReferencedLawyerInput;
}): Promise<AdminReferencedLawyerSaveResponse> {
  return apiRequest<AdminReferencedLawyerSaveResponse>("/api/admin/lawyers", {
    method: "POST",
    body: args.data,
  });
}

export function fetchAdminLawyerReferralRequests(
  input: { offset?: number; limit?: number } = {},
): Promise<AdminLawyerReferralListResponse> {
  const search = new URLSearchParams({
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 50),
  });
  return apiRequest<AdminLawyerReferralListResponse>(
    "/api/admin/lawyer-referrals?" + search.toString(),
  );
}

export function updateAdminLawyerReferralRequest(args: {
  data: AdminLawyerReferralUpdateInput;
}): Promise<AdminLawyerReferralUpdateResponse> {
  return apiRequest<AdminLawyerReferralUpdateResponse>("/api/admin/lawyer-referrals", {
    method: "PATCH",
    body: args.data,
  });
}

export function fetchAdminSubscriptions(
  input: { offset?: number; limit?: number } = {},
): Promise<AdminSubscriptionListResponse> {
  const search = new URLSearchParams({
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 50),
  });
  return apiRequest<AdminSubscriptionListResponse>("/api/admin/subscriptions?" + search.toString());
}

export function grantAdminSubscription(args: {
  data: AdminSubscriptionGrantInput;
}): Promise<AdminSubscriptionGrantResponse> {
  return apiRequest<AdminSubscriptionGrantResponse>("/api/admin/subscriptions", {
    method: "POST",
    body: args.data,
  });
}

export function fetchAdminPilotage(): Promise<AdminPilotageResponse> {
  return apiRequest<AdminPilotageResponse>("/api/admin/pilotage");
}

/**
 * Personnes qui ont accepté un entretien (questionnaire de la liste d'attente), administrateur
 * seulement. Chargée à la demande : elle porte des adresses email, la réponse de « Pilotage » non.
 */
export function fetchAdminOfferOpeningInterviewees(): Promise<OfferOpeningInterviewees> {
  return apiRequest<OfferOpeningInterviewees>("/api/admin/offer-opening-interviewees");
}

/** Relevé mensuel des avocats référencés (`month` : AAAA-MM), administrateur seulement. */
export function fetchAdminLawyerStatement(month: string): Promise<LawyerStatement> {
  return apiRequest<LawyerStatement>(
    `/api/admin/lawyers/statement?month=${encodeURIComponent(month)}`,
  );
}

export function fetchAdminLaunchOffer(): Promise<AdminLaunchOfferState> {
  return apiRequest<AdminLaunchOfferState>("/api/admin/launch-offer");
}

export function setAdminLaunchOfferClient(active: boolean): Promise<AdminLaunchOfferState> {
  return apiRequest<AdminLaunchOfferState>("/api/admin/launch-offer", {
    method: "POST",
    body: { active },
  });
}

export function fetchAdminOfferOpeningAudience(): Promise<OfferOpeningAudience> {
  return apiRequest<OfferOpeningAudience>("/api/admin/offer-opening-notifier");
}

/** Envoi d'essai du message d'ouverture à l'adresse de l'administrateur. */
export function sendAdminOfferOpeningTest(): Promise<OfferOpeningTestResult> {
  return apiRequest<OfferOpeningTestResult>("/api/admin/offer-opening-notifier", {
    method: "POST",
    body: { action: "test" },
  });
}

/** Envoie un lot (200 au plus) à la liste d'attente ; relancé, il ne reprend que les non prévenus. */
export function sendAdminOfferOpeningBatch(): Promise<OfferOpeningSendResult> {
  return apiRequest<OfferOpeningSendResult>("/api/admin/offer-opening-notifier", {
    method: "POST",
    body: { action: "send", confirm: true },
  });
}
