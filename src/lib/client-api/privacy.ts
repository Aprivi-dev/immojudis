import { apiRequest } from "@/lib/client-api-core";
import type { ProfessionalDataExport } from "@/lib/information-agent-professional-rights";
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

export function fetchPrivacyRequests(): Promise<PrivacyRequestListResponse> {
  return apiRequest<PrivacyRequestListResponse>("/api/privacy/requests");
}

export function createPrivacyRequestClient(
  data: PrivacyRequestInput,
): Promise<PrivacyRequestSummary> {
  return apiRequest<PrivacyRequestSummary>("/api/privacy/requests", { method: "POST", body: data });
}

export function fetchAdminPrivacyRequests(
  input: { offset?: number; limit?: number } = {},
): Promise<PrivacyRequestAdminListResponse> {
  const search = new URLSearchParams({
    offset: String(input.offset ?? 0),
    limit: String(input.limit ?? 100),
  });
  return apiRequest<PrivacyRequestAdminListResponse>(
    "/api/admin/privacy-requests?" + search.toString(),
  );
}

export function updateAdminPrivacyRequest(
  data: PrivacyRequestAdminUpdate,
): Promise<PrivacyRequestAdminSummary> {
  return apiRequest<PrivacyRequestAdminSummary>("/api/admin/privacy-requests", {
    method: "PATCH",
    body: data,
  });
}

export function executeAdminContractWithdrawal(data: {
  requestId: string;
  refundMode: "prorata" | "full";
}): Promise<{ refundedCents: number; subscriptionCancelled: boolean }> {
  return apiRequest<{ refundedCents: number; subscriptionCancelled: boolean }>(
    "/api/admin/privacy-requests/withdrawal",
    { method: "POST", body: data },
  );
}

/** Copie des données d'un professionnel sans compte qui a demandé l'accès (administrateur). */
export function fetchAdminProfessionalPrivacyExport(
  requestId: string,
): Promise<ProfessionalDataExport> {
  const search = new URLSearchParams({ requestId });
  return apiRequest<ProfessionalDataExport>(
    "/api/admin/privacy-requests/professional-export?" + search,
  );
}

export function executeAdminPrivacyErasure(
  data: PrivacyErasureExecuteInput,
): Promise<PrivacyErasureReport> {
  return apiRequest<PrivacyErasureReport>("/api/admin/privacy-requests", {
    method: "POST",
    body: data,
  });
}
