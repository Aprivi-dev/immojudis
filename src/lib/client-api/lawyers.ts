import { authHeaders, readJson } from "@/lib/client-api-core";
import type { FeaturedReferencedLawyerResponse } from "@/lib/featured-lawyers";
import type { LawyerDirectoryResponse } from "@/lib/lawyer-directory";
import type {
  LawyerPlacementEventInput,
  LawyerPlacementEventResponse,
} from "@/lib/lawyer-placement-events";
import type {
  LawyerReferralListResponse,
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
