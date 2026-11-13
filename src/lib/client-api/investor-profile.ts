import { apiRequest } from "@/lib/client-api-core";
import type { InvestorProfileInput } from "@/lib/investor-profile-input";
import type {
  InvestorProfileDeleteResponse,
  InvestorProfileResponse,
} from "@/lib/investor-profile";

/** Profil d'investisseur du compte (n° 93) : lu, remplacé ou effacé par son propriétaire. */
export function fetchInvestorProfile(): Promise<InvestorProfileResponse> {
  return apiRequest<InvestorProfileResponse>("/api/investor-profile");
}

export function saveInvestorProfile(args: {
  data: InvestorProfileInput;
}): Promise<InvestorProfileResponse> {
  return apiRequest<InvestorProfileResponse>("/api/investor-profile", {
    method: "PUT",
    body: args.data,
  });
}

export function deleteInvestorProfile(): Promise<InvestorProfileDeleteResponse> {
  return apiRequest<InvestorProfileDeleteResponse>("/api/investor-profile", { method: "DELETE" });
}
