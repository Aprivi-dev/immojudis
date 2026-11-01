import { authHeaders, readJson } from "@/lib/client-api-core";
import type { InvestorProfileInput } from "@/lib/investor-profile-input";
import type {
  InvestorProfileDeleteResponse,
  InvestorProfileResponse,
} from "@/lib/investor-profile";

/** Profil d'investisseur du compte (n° 93) : lu, remplacé ou effacé par son propriétaire. */
export async function fetchInvestorProfile(): Promise<InvestorProfileResponse> {
  const response = await fetch("/api/investor-profile", { headers: await authHeaders() });
  return readJson<InvestorProfileResponse>(response);
}

export async function saveInvestorProfile(args: {
  data: InvestorProfileInput;
}): Promise<InvestorProfileResponse> {
  const response = await fetch("/api/investor-profile", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });
  return readJson<InvestorProfileResponse>(response);
}

export async function deleteInvestorProfile(): Promise<InvestorProfileDeleteResponse> {
  const response = await fetch("/api/investor-profile", {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return readJson<InvestorProfileDeleteResponse>(response);
}
