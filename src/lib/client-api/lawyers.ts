import { apiRequest } from "@/lib/client-api-core";
import type { LawyerDirectoryResponse } from "@/lib/lawyer-directory";
import type { LawyerProsecutedSalesResponse } from "@/lib/lawyer-prosecuted-sales";
import type {
  LawyerReferralListResponse,
  LawyerReferralPreviewResponse,
  LawyerReferralRequestInput,
  LawyerReferralResponse,
} from "@/lib/lawyer-referrals";

export function requestLawyerReferral(args: {
  data: LawyerReferralRequestInput;
}): Promise<LawyerReferralResponse> {
  return apiRequest<LawyerReferralResponse>("/api/lawyer-referrals", {
    method: "POST",
    body: args.data,
  });
}

export function fetchLawyerReferralPreview(args: {
  saleId: string;
  lawyerId?: string;
}): Promise<LawyerReferralPreviewResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  if (args.lawyerId) search.set("lawyerId", args.lawyerId);
  return apiRequest<LawyerReferralPreviewResponse>(
    `/api/lawyer-referrals/preview?${search.toString()}`,
  );
}

export function fetchLawyerReferrals(
  args: {
    saleId?: string;
    limit?: number;
  } = {},
): Promise<LawyerReferralListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  if (args.limit) search.set("limit", String(args.limit));
  return apiRequest<LawyerReferralListResponse>(
    `/api/lawyer-referrals${search.size ? `?${search.toString()}` : ""}`,
  );
}

export function fetchLawyerDirectory(
  args: { saleId?: string; bar?: string; city?: string; department?: string; page?: number } = {},
): Promise<LawyerDirectoryResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  if (args.bar) search.set("bar", args.bar);
  if (args.city) search.set("city", args.city);
  if (args.department) search.set("department", args.department);
  if (args.page && args.page > 1) search.set("page", String(args.page));
  const suffix = search.size ? `?${search.toString()}` : "";
  return apiRequest<LawyerDirectoryResponse>(`/api/lawyers/directory${suffix}`, {
    anonymous: true,
  });
}

/**
 * Ventes à venir où les avocats demandés sont avocat poursuivant. Route authentifiée, réservée aux
 * comptes payants : ne l'appeler que pour eux (les autres reçoivent un 403).
 */
export function fetchLawyerProsecutedSales(
  lawyerIds: readonly string[],
): Promise<LawyerProsecutedSalesResponse> {
  const search = new URLSearchParams({ lawyerIds: lawyerIds.join(",") });
  return apiRequest<LawyerProsecutedSalesResponse>(
    `/api/lawyers/prosecuted-sales?${search.toString()}`,
  );
}
