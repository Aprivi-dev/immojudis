import { apiRequest } from "@/lib/client-api-core";
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
  AdminFactClaimDecisionInput,
  AdminFactClaimDecisionListResponse,
  AdminFactClaimDecisionResult,
} from "@/lib/admin-fact-claim-decisions";
import type {
  AdminInformationAgentMessageAction,
  AdminInformationAgentReviewInput,
  AdminInformationAgentReviewResponse,
  AdminInformationAgentUnroutedAction,
  AdminInformationAgentUnroutedResponse,
} from "@/lib/admin-information-agent";
import type {
  AdminSourceRefreshRequestInput,
  AdminSourceRefreshResponse,
} from "@/lib/admin-source-refresh";
import type { AdminAutopilotAction } from "@/lib/admin-information-agent-autopilot";
import type { AutopilotView } from "@/lib/information-agent/autopilot-view";
import type { InformationAgentOperationsView } from "@/lib/information-agent/operations-view";
import type {
  InformationAgentAdminActionPayload,
  InformationAgentAdminListResponse,
  InformationAgentAdminMissionPage,
  InformationAgentCreateInput,
  InformationAgentPreviewInput,
} from "@/lib/information-agent/schemas";
import type { InformationAgentPrepareResponse } from "@/lib/information-agent/prepare";
import type { InformationAgentPreviewResponse } from "@/lib/information-agent/preview";
import type {
  InformationAgentEmailTemplateContent,
  InformationAgentEmailTemplatePreview,
  InformationAgentEmailTemplateWorkspace,
} from "@/lib/information-agent-email-template";

export function fetchAdminInformationAgentEmailTemplate(): Promise<InformationAgentEmailTemplateWorkspace> {
  return apiRequest<InformationAgentEmailTemplateWorkspace>(
    "/api/admin/information-agent/template",
  );
}

export function fetchAdminCatalogueReadiness(args?: {
  offset?: number;
  limit?: number;
}): Promise<CatalogueReadinessOverview> {
  const search = new URLSearchParams();
  if (args?.offset != null) search.set("offset", String(args.offset));
  if (args?.limit != null) search.set("limit", String(args.limit));
  const suffix = search.size ? `?${search.toString()}` : "";
  return apiRequest<CatalogueReadinessOverview>(`/api/admin/catalogue-readiness${suffix}`);
}

export function runAdminCatalogueReadinessActionClient(
  data: AdminCatalogueReadinessAction,
): Promise<CatalogueReadinessOverview> {
  return apiRequest<CatalogueReadinessOverview>("/api/admin/catalogue-readiness", {
    method: "PATCH",
    body: data,
  });
}

export type AdminAuctionFactClaimReviewPageParam = {
  offset?: number;
  limit?: number;
  status?: "candidate" | "conflicted";
};

export function fetchAdminAuctionFactClaimReview(
  pageParam: AdminAuctionFactClaimReviewPageParam = {},
): Promise<AdminAuctionFactClaimReviewResponse> {
  const search = new URLSearchParams();
  search.set("offset", String(pageParam.offset ?? 0));
  search.set("limit", String(pageParam.limit ?? ADMIN_PAGE_SIZE));
  if (pageParam.status) search.set("status", pageParam.status);
  return apiRequest<AdminAuctionFactClaimReviewResponse>(
    `/api/admin/fact-claims/review?${search.toString()}`,
  );
}

export function reviewAdminAuctionFactClaimClient(
  data: AdminAuctionFactClaimDecision,
): Promise<{ ok: true; result: unknown }> {
  return apiRequest<{ ok: true; result: unknown }>("/api/admin/fact-claims/review", {
    method: "POST",
    body: data,
  });
}

/** Registre des pièces : observations à décider, d'une vente ou de la file des origines réservées. */
export function fetchAdminFactClaimDecisions(args: {
  saleId?: string;
  offset?: number;
  limit?: number;
}): Promise<AdminFactClaimDecisionListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  search.set("offset", String(args.offset ?? 0));
  search.set("limit", String(args.limit ?? ADMIN_PAGE_SIZE));
  return apiRequest<AdminFactClaimDecisionListResponse>(
    `/api/admin/fact-claims/decisions?${search.toString()}`,
  );
}

export function decideAdminFactClaimClient(
  data: AdminFactClaimDecisionInput,
): Promise<AdminFactClaimDecisionResult> {
  return apiRequest<AdminFactClaimDecisionResult>("/api/admin/fact-claims/decisions", {
    method: "POST",
    body: data,
  });
}

export function fetchAdminInformationAgentMissions(args?: {
  saleId?: string;
  offset?: number;
  limit?: number;
}): Promise<InformationAgentAdminMissionPage> {
  const search = new URLSearchParams();
  if (args?.saleId) search.set("saleId", args.saleId);
  search.set("offset", String(args?.offset ?? 0));
  search.set("limit", String(args?.limit ?? ADMIN_PAGE_SIZE));
  return apiRequest<InformationAgentAdminMissionPage>(
    `/api/admin/information-agent/missions?${search.toString()}`,
  );
}

/** Prépare un brouillon (créé ou retrouvé) et rend son aperçu exact dans la même réponse. N'envoie rien. */
export function createAdminInformationAgentMission(
  data: InformationAgentCreateInput,
): Promise<InformationAgentPrepareResponse> {
  return apiRequest<InformationAgentPrepareResponse>(
    "/api/admin/information-agent/missions/prepare",
    { method: "POST", body: data },
  );
}

export function runAdminInformationAgentMissionAction(
  data: InformationAgentAdminActionPayload,
): Promise<InformationAgentAdminListResponse> {
  return apiRequest<InformationAgentAdminListResponse>("/api/admin/information-agent/missions", {
    method: "PATCH",
    body: data,
  });
}

/** Aperçu exact de l'e-mail d'une mission ; n'enregistre ni n'envoie rien. */
export function previewAdminInformationAgentMission(
  data: InformationAgentPreviewInput,
): Promise<InformationAgentPreviewResponse> {
  return apiRequest<InformationAgentPreviewResponse>(
    "/api/admin/information-agent/missions/preview",
    { method: "POST", body: data },
  );
}

export function fetchAdminSourceRefreshStatus(saleId: string): Promise<AdminSourceRefreshResponse> {
  const search = new URLSearchParams({ saleId });
  return apiRequest<AdminSourceRefreshResponse>(
    `/api/admin/information-agent/source-refresh?${search.toString()}`,
  );
}

export function requestAdminSourceRefresh(
  data: AdminSourceRefreshRequestInput,
): Promise<AdminSourceRefreshResponse> {
  return apiRequest<AdminSourceRefreshResponse>("/api/admin/information-agent/source-refresh", {
    method: "POST",
    body: data,
  });
}

export type AdminInformationAgentReviewPageParam = {
  offset?: number;
  limit?: number;
};

export function fetchAdminInformationAgentReview(
  pageParam: AdminInformationAgentReviewPageParam = {},
): Promise<AdminInformationAgentReviewResponse> {
  const search = new URLSearchParams();
  search.set("offset", String(pageParam.offset ?? 0));
  search.set("limit", String(pageParam.limit ?? ADMIN_PAGE_SIZE));
  return apiRequest<AdminInformationAgentReviewResponse>(
    `/api/admin/information-agent?${search.toString()}`,
  );
}

export function reviewAdminInformationAgentFactClient(
  data: AdminInformationAgentReviewInput,
): Promise<{ ok: true; result: unknown }> {
  return apiRequest<{ ok: true; result: unknown }>("/api/admin/information-agent", {
    method: "PATCH",
    body: data,
  });
}

/** Opposition du professionnel ou réponse traitée, depuis la file de revue. */
export function runAdminInformationAgentMessageActionClient(
  data: AdminInformationAgentMessageAction,
): Promise<{ ok: true; opposedEmails: string[] }> {
  return apiRequest<{ ok: true; opposedEmails: string[] }>("/api/admin/information-agent", {
    method: "POST",
    body: data,
  });
}

/** Messages reçus sans dossier ouvert, encore à traiter. */
export function fetchAdminInformationAgentUnrouted(
  pageParam: AdminInformationAgentReviewPageParam = {},
): Promise<AdminInformationAgentUnroutedResponse> {
  const search = new URLSearchParams();
  search.set("offset", String(pageParam.offset ?? 0));
  search.set("limit", String(pageParam.limit ?? ADMIN_PAGE_SIZE));
  return apiRequest<AdminInformationAgentUnroutedResponse>(
    `/api/admin/information-agent/unrouted?${search.toString()}`,
  );
}

/** « Marquer comme traité » un message reçu sans dossier ouvert. */
export function markAdminInformationAgentUnroutedHandledClient(
  data: AdminInformationAgentUnroutedAction,
): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>("/api/admin/information-agent/unrouted", {
    method: "POST",
    body: data,
  });
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
  const payload = await apiRequest<{ signedUrl?: string }>(
    `/api/admin/information-agent/evidence/${encodeURIComponent(assetId)}?format=json`,
  );
  if (!payload.signedUrl) throw new Error("Lien sécurisé de la pièce indisponible.");
  return payload.signedUrl;
}

export function updateAdminInformationAgentEvidenceRightsClient({
  assetId,
  rightsStatus,
  notes,
}: {
  assetId: string;
  rightsStatus: AdminInformationAgentEvidenceRightsStatus;
  notes: string | null;
}): Promise<AdminInformationAgentEvidenceRightsResponse> {
  return apiRequest<AdminInformationAgentEvidenceRightsResponse>(
    `/api/admin/information-agent/evidence/${encodeURIComponent(assetId)}`,
    { method: "PATCH", body: { rightsStatus, notes } },
  );
}

export function previewAdminInformationAgentEmailTemplate(
  template: InformationAgentEmailTemplateContent,
): Promise<{ preview: InformationAgentEmailTemplatePreview }> {
  return apiRequest<{ preview: InformationAgentEmailTemplatePreview }>(
    "/api/admin/information-agent/template",
    { method: "POST", body: { action: "preview", template } },
  );
}

export function saveAdminInformationAgentEmailTemplateDraft(args: {
  draftId: string | null;
  template: InformationAgentEmailTemplateContent;
}): Promise<InformationAgentEmailTemplateWorkspace> {
  return apiRequest<InformationAgentEmailTemplateWorkspace>(
    "/api/admin/information-agent/template",
    { method: "POST", body: { action: "save_draft", ...args } },
  );
}

export function publishAdminInformationAgentEmailTemplateDraft(
  draftId: string,
): Promise<InformationAgentEmailTemplateWorkspace> {
  return apiRequest<InformationAgentEmailTemplateWorkspace>(
    "/api/admin/information-agent/template",
    { method: "POST", body: { action: "publish", draftId, publicationConfirmed: true } },
  );
}

/** Indicateurs d'exploitation de l'agent (30 jours) et état de l'aller-retour de réception, déjà mis en forme. */
export function fetchAdminInformationAgentOperations(): Promise<InformationAgentOperationsView> {
  return apiRequest<InformationAgentOperationsView>("/api/admin/information-agent/operations");
}

/** « J'ai vérifié l'aller-retour réel » : enregistre la date de la vérification. */
export function attestAdminInformationAgentRoundtripClient(): Promise<InformationAgentOperationsView> {
  return apiRequest<InformationAgentOperationsView>("/api/admin/information-agent/operations", {
    method: "POST",
  });
}

/** État du pilote automatique, déjà mis en forme par le serveur. */
export function fetchAdminInformationAgentAutopilot(): Promise<AutopilotView> {
  return apiRequest<AutopilotView>("/api/admin/information-agent/autopilot");
}

/** Mode, réglages, arrêt d'urgence ou attestation d'AIPD (motif obligatoire, sauf l'arrêt d'urgence). */
export function runAdminInformationAgentAutopilotActionClient(
  data: AdminAutopilotAction,
): Promise<AutopilotView> {
  return apiRequest<AutopilotView>("/api/admin/information-agent/autopilot", {
    method: "POST",
    body: data,
  });
}
