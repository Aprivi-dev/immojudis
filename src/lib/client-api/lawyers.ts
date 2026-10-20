import { authHeaders, readJson } from "@/lib/client-api-core";
import type { FeaturedReferencedLawyerResponse } from "@/lib/featured-lawyers";
import type { LawyerDirectoryResponse } from "@/lib/lawyer-directory";
import type { LawyerProsecutedSalesResponse } from "@/lib/lawyer-prosecuted-sales";
import type {
  LawyerPlacementEventInput,
  LawyerPlacementEventResponse,
} from "@/lib/lawyer-placement-events";
import type {
  LawyerReferralListResponse,
  LawyerReferralPreviewResponse,
  LawyerReferralRequestInput,
  LawyerReferralResponse,
} from "@/lib/lawyer-referrals";

export async function requestLawyerReferral(args: {
  data: LawyerReferralRequestInput;
}): Promise<LawyerReferralResponse> {
  const response = await fetch("/api/lawyer-referrals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<LawyerReferralResponse>(response);
}

export async function fetchLawyerReferralPreview(args: {
  saleId: string;
  lawyerId?: string;
}): Promise<LawyerReferralPreviewResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  if (args.lawyerId) search.set("lawyerId", args.lawyerId);
  const response = await fetch(`/api/lawyer-referrals/preview?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<LawyerReferralPreviewResponse>(response);
}

export async function fetchLawyerReferrals(
  args: {
    saleId?: string;
    limit?: number;
  } = {},
): Promise<LawyerReferralListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  if (args.limit) search.set("limit", String(args.limit));
  const response = await fetch(
    `/api/lawyer-referrals${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<LawyerReferralListResponse>(response);
}

export async function fetchFeaturedReferencedLawyer(args: {
  saleId: string;
}): Promise<FeaturedReferencedLawyerResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/lawyers/featured?${search.toString()}`);

  return readJson<FeaturedReferencedLawyerResponse>(response);
}

export async function fetchLawyerDirectory(
  args: { saleId?: string; bar?: string; city?: string; department?: string } = {},
): Promise<LawyerDirectoryResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  if (args.bar) search.set("bar", args.bar);
  if (args.city) search.set("city", args.city);
  if (args.department) search.set("department", args.department);
  const suffix = search.size ? `?${search.toString()}` : "";
  const response = await fetch(`/api/lawyers/directory${suffix}`);
  return readJson<LawyerDirectoryResponse>(response);
}

/**
 * Ventes à venir où les avocats demandés sont avocat poursuivant. Route authentifiée, réservée aux
 * comptes payants : ne l'appeler que pour eux (les autres reçoivent un 403).
 */
export async function fetchLawyerProsecutedSales(
  lawyerIds: readonly string[],
): Promise<LawyerProsecutedSalesResponse> {
  const search = new URLSearchParams({ lawyerIds: lawyerIds.join(",") });
  const response = await fetch(`/api/lawyers/prosecuted-sales?${search.toString()}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<LawyerProsecutedSalesResponse>(response);
}

export async function recordLawyerPlacementEvent(args: {
  data: LawyerPlacementEventInput;
}): Promise<LawyerPlacementEventResponse> {
  const response = await fetch("/api/lawyers/placement-events", {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<LawyerPlacementEventResponse>(response);
}
