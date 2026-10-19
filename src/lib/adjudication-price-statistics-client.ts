import { authHeaders } from "@/lib/client-api-core";
import {
  adjudicationPriceStatisticsResponseSchema,
  adjudicationPriceStatisticsDirectoryResponseSchema,
  type AdjudicationPriceStatisticsDirectoryResponse,
  type AdjudicationPriceStatisticsResponse,
} from "@/lib/adjudication-price-statistics";

export async function fetchAdjudicationPriceStatistics(
  saleId: string,
): Promise<AdjudicationPriceStatisticsResponse> {
  // Chargement différé de supabase-js, et seulement s'il y a une session stockée : un visiteur
  // anonyme de /tribunaux ne télécharge pas le client d'authentification pour apprendre qu'il
  // doit se connecter.
  const headers = await authHeaders();

  const response = await fetch(
    `/api/v1/sales/${encodeURIComponent(saleId)}/adjudication-statistics`,
    { headers, cache: "no-store" },
  );
  const payload = (await response.json().catch(() => null)) as
    | (unknown & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return adjudicationPriceStatisticsResponseSchema.parse(payload);
}

export async function fetchAdjudicationPriceStatisticsDirectory(): Promise<AdjudicationPriceStatisticsDirectoryResponse> {
  const headers = await authHeaders();

  const response = await fetch("/api/v1/tribunals/adjudication-statistics", {
    headers,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (unknown & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return adjudicationPriceStatisticsDirectoryResponseSchema.parse(payload);
}
