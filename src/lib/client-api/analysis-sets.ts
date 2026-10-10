import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  SaleAnalysisSetInput,
  SaleAnalysisSetListResponse,
  SaleAnalysisSetResponse,
  SaleAnalysisSetUpdateInput,
  SaleComparisonShareResponse,
} from "@/lib/sale-analysis-sets";

export async function fetchSaleAnalysisSets(
  args: {
    includeArchived?: boolean;
  } = {},
): Promise<SaleAnalysisSetListResponse> {
  const search = new URLSearchParams();
  if (args.includeArchived) search.set("includeArchived", "true");
  const response = await fetch(
    `/api/sale-analysis-sets${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SaleAnalysisSetListResponse>(response);
}

export async function createSaleAnalysisSet(args: {
  data: SaleAnalysisSetInput;
}): Promise<SaleAnalysisSetResponse> {
  const response = await fetch("/api/sale-analysis-sets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleAnalysisSetResponse>(response);
}

export async function updateSaleAnalysisSet(args: {
  setId: string;
  data: SaleAnalysisSetUpdateInput;
}): Promise<SaleAnalysisSetResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<SaleAnalysisSetResponse>(response);
}

export async function deleteSaleAnalysisSet(args: { setId: string }): Promise<{ ok: true }> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<{ ok: true }>(response);
}

export async function enableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<SaleComparisonShareResponse>(response);
}

export async function disableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  const response = await fetch(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<SaleComparisonShareResponse>(response);
}
