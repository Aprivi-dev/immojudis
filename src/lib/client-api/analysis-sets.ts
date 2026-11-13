import { apiRequest } from "@/lib/client-api-core";
import type {
  SaleAnalysisSetInput,
  SaleAnalysisSetListResponse,
  SaleAnalysisSetResponse,
  SaleComparisonShareResponse,
} from "@/lib/sale-analysis-sets";

export function fetchSaleAnalysisSets(): Promise<SaleAnalysisSetListResponse> {
  return apiRequest<SaleAnalysisSetListResponse>("/api/sale-analysis-sets");
}

export function createSaleAnalysisSet(args: {
  data: SaleAnalysisSetInput;
}): Promise<SaleAnalysisSetResponse> {
  return apiRequest<SaleAnalysisSetResponse>("/api/sale-analysis-sets", {
    method: "POST",
    body: args.data,
  });
}

export function deleteSaleAnalysisSet(args: { setId: string }): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>(`/api/sale-analysis-sets/${args.setId}`, { method: "DELETE" });
}

export function enableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  return apiRequest<SaleComparisonShareResponse>(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "POST",
  });
}

export function disableSaleComparisonShare(args: {
  setId: string;
}): Promise<SaleComparisonShareResponse> {
  return apiRequest<SaleComparisonShareResponse>(`/api/sale-analysis-sets/${args.setId}/share`, {
    method: "DELETE",
  });
}
