import { apiRequest } from "@/lib/client-api-core";
import type { ProfessionalPilotSaveInput, SaleWorkspaceResponse } from "@/lib/sale-workspaces";

export function fetchSaleWorkspace(args: { saleId: string }): Promise<SaleWorkspaceResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  return apiRequest<SaleWorkspaceResponse>(`/api/sale-workspace?${search.toString()}`);
}

export function saveProfessionalPilotDossier(
  data: ProfessionalPilotSaveInput,
): Promise<SaleWorkspaceResponse> {
  return apiRequest<SaleWorkspaceResponse>("/api/sale-workspace/professional-pilot", {
    method: "PUT",
    body: data,
  });
}
