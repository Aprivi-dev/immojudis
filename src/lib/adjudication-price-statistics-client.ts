import { apiRequest } from "@/lib/client-api-core";
import {
  adjudicationPriceStatisticsResponseSchema,
  adjudicationPriceStatisticsDirectoryResponseSchema,
  type AdjudicationPriceStatisticsDirectoryResponse,
  type AdjudicationPriceStatisticsResponse,
} from "@/lib/adjudication-price-statistics";

// Sans session stockée, `apiRequest` refuse sans charger supabase-js : un visiteur anonyme de
// /tribunaux ne télécharge pas le client d'authentification pour apprendre qu'il doit se connecter.

export async function fetchAdjudicationPriceStatistics(
  saleId: string,
): Promise<AdjudicationPriceStatisticsResponse> {
  return adjudicationPriceStatisticsResponseSchema.parse(
    await apiRequest<unknown>(
      `/api/v1/sales/${encodeURIComponent(saleId)}/adjudication-statistics`,
    ),
  );
}

export async function fetchAdjudicationPriceStatisticsDirectory(): Promise<AdjudicationPriceStatisticsDirectoryResponse> {
  return adjudicationPriceStatisticsDirectoryResponseSchema.parse(
    await apiRequest<unknown>("/api/v1/tribunals/adjudication-statistics"),
  );
}
