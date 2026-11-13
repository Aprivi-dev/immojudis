import { chunks } from "@/lib/chunks";
import { apiDownload, apiFetch, apiRequest, readJson, responseError } from "@/lib/client-api-core";
import type { StructuredCadastralParcel } from "@/lib/cadastre-analysis";
import type { FactReliabilityMap } from "@/lib/fact-reliability";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import type { SaleMarketContext } from "@/lib/market-estimate-ceiling";
import type { ValuePreview } from "@/lib/value-preview";
import type { OutcomeGraphForecast } from "@/lib/outcome-graph";
import type { DpeExplorerResponse } from "@/lib/dpe-explorer";
import type { SalePassagesResponse } from "@/lib/sale-passages";
import type { AuctionScenariosResponse, CourtAuctionSummary } from "@/lib/auction-scenarios";
import type { DocumentReadingResponse } from "@/lib/document-reading";
import type {
  SaleUnlockQuotaReachedResponse,
  SaleUnlockResult,
  SaleUnlockStatus,
  SaleUnlocksOverview,
} from "@/lib/sale-unlocks";
import { SALE_UNLOCK_QUOTA_MESSAGE } from "@/lib/sale-unlock-quota-message";
import type { StructuredUrbanPlanningSignal } from "@/lib/urban-planning-analysis";
import type { ValuationAdminResponse } from "@/lib/valuation-admin";
import type { SalesStatisticsResponse } from "@/lib/sales-statistics";
import { salesSearchToUrlRecord, type SalesSearchParams } from "@/lib/search/search-url-state";

export type SaleFactReliabilitiesResponse = {
  facts: FactReliabilityMap;
  source: "claims" | "legacy";
};

export type SaleAiReviewResponse = {
  projections: AiReviewProjectionReadModel[];
};

export async function fetchSalesAiReviewProjections(
  saleIds: readonly string[],
): Promise<SaleAiReviewResponse> {
  if (saleIds.length === 0) return { projections: [] };
  const results = await Promise.all(
    chunks(saleIds).map((batch) => {
      const search = new URLSearchParams();
      for (const saleId of batch) search.append("id", saleId);
      return apiRequest<SaleAiReviewResponse>(`/api/sales/ai-review?${search.toString()}`);
    }),
  );
  return { projections: results.flatMap((result) => result.projections) };
}

export function fetchSaleAiReviewProjections(saleId: string): Promise<SaleAiReviewResponse> {
  return fetchSalesAiReviewProjections([saleId]);
}

export function fetchSaleFactReliabilities(saleId: string): Promise<SaleFactReliabilitiesResponse> {
  return apiRequest<SaleFactReliabilitiesResponse>(
    `/api/sales/${encodeURIComponent(saleId)}/facts`,
  );
}

export function fetchValuePreview(saleId: string): Promise<ValuePreview> {
  return apiRequest<ValuePreview>(`/api/sales/${encodeURIComponent(saleId)}/value-preview`);
}

/** Where the account stands this month and whether this sale is unlocked. Consumes nothing. */
export async function fetchSaleUnlockStatus(saleId: string): Promise<SaleUnlockStatus> {
  return (
    await apiRequest<{ status: SaleUnlockStatus }>(
      `/api/sales/${encodeURIComponent(saleId)}/unlock`,
    )
  ).status;
}

/** The month so far (used, reset date) and the sales this account unlocked. Consumes nothing. */
export function fetchSaleUnlocksOverview(): Promise<SaleUnlocksOverview> {
  return apiRequest<SaleUnlocksOverview>("/api/sale-unlocks");
}

/** The monthly quota is spent: carries the counter so the page can explain it. */
export class SaleUnlockQuotaReachedError extends Error {
  readonly status: SaleUnlockStatus;

  constructor(status: SaleUnlockStatus) {
    super(SALE_UNLOCK_QUOTA_MESSAGE);
    this.name = "SaleUnlockQuotaReachedError";
    this.status = status;
  }
}

/** Unlocks this sale (idempotent: an already unlocked sale consumes nothing). */
export async function unlockSaleRequest(saleId: string): Promise<SaleUnlockResult> {
  const response = await apiFetch(`/api/sales/${encodeURIComponent(saleId)}/unlock`, {
    method: "POST",
    timeoutMs: 15_000,
  });
  if (response.status === 409) {
    const payload = (await response
      .clone()
      .json()
      .catch(() => null)) as SaleUnlockQuotaReachedResponse | null;
    if (payload?.code === "unlock_quota_reached") {
      throw new SaleUnlockQuotaReachedError(payload.status);
    }
  }
  return (await readJson<{ result: SaleUnlockResult }>(response)).result;
}

export function fetchDocumentReading(saleId: string): Promise<DocumentReadingResponse> {
  return apiRequest<DocumentReadingResponse>(
    `/api/sales/${encodeURIComponent(saleId)}/document-reading`,
  );
}

export function fetchSalePassages(saleId: string): Promise<SalePassagesResponse> {
  return apiRequest<SalePassagesResponse>(`/api/sales/${encodeURIComponent(saleId)}/passages`);
}

export function fetchAuctionScenarios(saleId: string): Promise<AuctionScenariosResponse> {
  return apiRequest<AuctionScenariosResponse>(
    `/api/sales/${encodeURIComponent(saleId)}/auction-scenarios`,
  );
}

export function fetchCourtAuctionSummaries(): Promise<{ courts: CourtAuctionSummary[] }> {
  return apiRequest<{ courts: CourtAuctionSummary[] }>("/api/v1/tribunals/auction-summaries");
}

export async function fetchPrecomputedMarketEstimate(args: {
  saleId: string;
  /**
   * La valeur est recalculée sur la surface que le compte a saisie dans « Mon dossier » : le serveur
   * la relit sur le compte (jamais envoyée par le navigateur) et ne rend que ce que lit le plafond.
   */
  enteredSurface?: boolean;
}): Promise<SaleMarketContext> {
  const response = await apiFetch("/api/market-estimate", {
    method: "POST",
    body: { saleId: args.saleId, ...(args.enteredSurface ? { enteredSurface: true } : {}) },
    // `maxDuration = 60` de la route.
    timeoutMs: 60_000,
  });

  const payload = (await response.json().catch(() => null)) as SaleMarketContext | null;
  if (response.status === 401 || response.status === 403 || !payload) {
    throw responseError(response.status, payload);
  }
  return payload;
}

export function fetchOutcomeGraphForecast(args: {
  saleId: string;
}): Promise<{ forecast: OutcomeGraphForecast }> {
  return apiRequest<{ forecast: OutcomeGraphForecast }>(
    `/api/v1/sales/${encodeURIComponent(args.saleId)}/outcome-graph`,
  );
}

export function fetchSaleUrbanismeCadastre(saleId: string): Promise<{
  cadastralParcels: StructuredCadastralParcel[];
  urbanPlanningSignals: StructuredUrbanPlanningSignal[];
}> {
  return apiRequest<{
    cadastralParcels: StructuredCadastralParcel[];
    urbanPlanningSignals: StructuredUrbanPlanningSignal[];
  }>(`/api/v1/sales/${encodeURIComponent(saleId)}/urbanisme-cadastre`);
}

export function fetchValuationAdminOverview(): Promise<ValuationAdminResponse> {
  return apiRequest<ValuationAdminResponse>("/api/admin/valuation-models");
}

export function fetchDpeExplorer(args: {
  department?: string;
  city?: string;
  propertyType?: string;
  dpeClasses?: string[];
  includeMap?: boolean;
  limit?: number;
}): Promise<DpeExplorerResponse> {
  const params = new URLSearchParams();
  if (args.department) params.set("department", args.department);
  if (args.city) params.set("city", args.city);
  if (args.propertyType) params.set("propertyType", args.propertyType);
  if (args.dpeClasses?.length) params.set("dpeClasses", args.dpeClasses.join(","));
  if (args.includeMap != null) params.set("includeMap", String(args.includeMap));
  if (args.limit) params.set("limit", String(args.limit));

  return apiRequest<DpeExplorerResponse>(`/api/dpe/explorer?${params.toString()}`);
}

/** Les critères de la recherche, en paramètres d'URL (les vides ne sont pas envoyés). */
function searchQuery(search: SalesSearchParams): string {
  const params = new URLSearchParams();
  Object.entries(salesSearchToUrlRecord(search)).forEach(([key, value]) => {
    if (value != null && value !== "") params.set(key, String(value));
  });
  return params.size ? `?${params.toString()}` : "";
}

export function fetchSalesStatistics(args: {
  search: SalesSearchParams;
}): Promise<SalesStatisticsResponse> {
  return apiRequest<SalesStatisticsResponse>(`/api/sales/statistics${searchQuery(args.search)}`);
}

export async function exportSalesCsv(args: {
  search: SalesSearchParams;
}): Promise<{ blob: Blob; filename: string }> {
  const { blob, filename } = await apiDownload(
    `/api/sales/export${searchQuery(args.search)}`,
    {},
    "immojudis-ventes.csv",
  );
  return { blob, filename };
}
