import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  AdminDashboardAiData,
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
