import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  AdminSignupListQuery,
  AdminSignupListResponse,
  AdminTrialExtensionInput,
  AdminTrialExtensionResponse,
} from "@/lib/admin-signups";

// Module à part : la page /admin/inscriptions ne charge pas tout le client de l'API admin.

export async function fetchAdminSignups(
  input: AdminSignupListQuery = {},
): Promise<AdminSignupListResponse> {
  // En POST : l'adresse ou le nom cherché ne doit pas figurer dans l'URL (journaux de l'hébergeur).
  const response = await fetch("/api/admin/signups/search", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({
      offset: input.offset ?? 0,
      limit: input.limit ?? 50,
      q: input.q ?? "",
      access: input.access ?? "all",
    }),
  });

  return readJson<AdminSignupListResponse>(response);
}

export async function extendAdminSignupTrials(
  input: AdminTrialExtensionInput,
): Promise<AdminTrialExtensionResponse> {
  const response = await fetch("/api/admin/signups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(input),
  });

  return readJson<AdminTrialExtensionResponse>(response);
}
