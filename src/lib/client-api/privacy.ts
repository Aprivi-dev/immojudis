import { authHeaders, readJson } from "@/lib/client-api-core";
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
