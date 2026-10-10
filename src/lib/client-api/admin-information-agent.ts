import { authHeaders, readJson } from "@/lib/client-api-core";
import { ADMIN_PAGE_SIZE } from "@/lib/admin-pagination";
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
