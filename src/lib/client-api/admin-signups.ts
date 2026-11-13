import { apiRequest } from "@/lib/client-api-core";
import type {
  AdminSignupListQuery,
  AdminSignupListResponse,
  AdminTrialExtensionInput,
  AdminTrialExtensionResponse,
} from "@/lib/admin-signups";

// Module à part : la page /admin/inscriptions ne charge pas tout le client de l'API admin.

export function fetchAdminSignups(
  input: AdminSignupListQuery = {},
): Promise<AdminSignupListResponse> {
  // En POST : l'adresse ou le nom cherché ne doit pas figurer dans l'URL (journaux de l'hébergeur).
  return apiRequest<AdminSignupListResponse>("/api/admin/signups/search", {
    method: "POST",
    body: {
      offset: input.offset ?? 0,
      limit: input.limit ?? 50,
      q: input.q ?? "",
      access: input.access ?? "all",
      activity: input.activity ?? "all",
    },
  });
}

export function extendAdminSignupTrials(
  input: AdminTrialExtensionInput,
): Promise<AdminTrialExtensionResponse> {
  return apiRequest<AdminTrialExtensionResponse>("/api/admin/signups", {
    method: "POST",
    body: input,
  });
}
