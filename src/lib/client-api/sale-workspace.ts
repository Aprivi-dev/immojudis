import { authHeaders, readJson } from "@/lib/client-api-core";
import type { ProfessionalPilotSaveInput, SaleWorkspaceResponse } from "@/lib/sale-workspaces";

export async function fetchSaleWorkspace(args: { saleId: string }): Promise<SaleWorkspaceResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/sale-workspace?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleWorkspaceResponse>(response);
}

export async function saveProfessionalPilotDossier(
  data: ProfessionalPilotSaveInput,
): Promise<SaleWorkspaceResponse> {
  const response = await fetch("/api/sale-workspace/professional-pilot", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(data),
  });
  return readJson<SaleWorkspaceResponse>(response);
}
