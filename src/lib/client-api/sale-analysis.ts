import { authHeaders, readJson } from "@/lib/client-api-core";
import type { BidCeilingAnalysisResponse, BidCeilingRequestInput } from "@/lib/bid-ceiling";
import type { StructuredCadastralParcel } from "@/lib/cadastre-analysis";
import type { EnvironmentalContextResponse } from "@/lib/environmental-context";
import type { FactReliabilityMap } from "@/lib/fact-reliability";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import type { MarketAnalyticsResponse } from "@/lib/market-analytics";
import type { MarketContext } from "@/lib/market.server";
import type { OutcomeGraphForecast } from "@/lib/outcome-graph";
import type { DvfComparablesResponse } from "@/lib/dvf-comparables";
import type { DpeExplorerResponse } from "@/lib/dpe-explorer";
import type { SaleHistoryResponse } from "@/lib/sale-history";
import type { StructuredUrbanPlanningSignal } from "@/lib/urban-planning-analysis";
import type { ValuationBacktestResponse } from "@/lib/valuation-backtest";
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
  const headers = await authHeaders();
  const batches: string[][] = [];
  for (let start = 0; start < saleIds.length; start += 100) {
    batches.push(saleIds.slice(start, start + 100));
  }
  const results = await Promise.all(
    batches.map(async (batch) => {
      const search = new URLSearchParams();
      for (const saleId of batch) search.append("id", saleId);
      const response = await fetch(`/api/sales/ai-review?${search.toString()}`, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      return readJson<SaleAiReviewResponse>(response);
    }),
  );
  return { projections: results.flatMap((result) => result.projections) };
}

export async function fetchSaleAiReviewProjections(saleId: string): Promise<SaleAiReviewResponse> {
  return fetchSalesAiReviewProjections([saleId]);
}

export async function fetchSaleFactReliabilities(
  saleId: string,
): Promise<SaleFactReliabilitiesResponse> {
  const response = await fetch(`/api/sales/${encodeURIComponent(saleId)}/facts`, {
    headers: await authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  return readJson<SaleFactReliabilitiesResponse>(response);
}

export async function fetchPrecomputedMarketEstimate(args: {
  saleId: string;
}): Promise<MarketContext> {
  const response = await fetch("/api/market-estimate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ saleId: args.saleId }),
  });

  const payload = (await response.json().catch(() => null)) as MarketContext | null;
  if (response.status === 401 || response.status === 403 || !payload) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return payload;
}

export async function fetchOutcomeGraphForecast(args: {
  saleId: string;
}): Promise<{ forecast: OutcomeGraphForecast }> {
  const response = await fetch(`/api/v1/sales/${encodeURIComponent(args.saleId)}/outcome-graph`, {
    headers: await authHeaders(),
    cache: "no-store",
  });

  return readJson<{ forecast: OutcomeGraphForecast }>(response);
}

export async function fetchSaleUrbanismeCadastre(saleId: string): Promise<{
  cadastralParcels: StructuredCadastralParcel[];
  urbanPlanningSignals: StructuredUrbanPlanningSignal[];
}> {
  const response = await fetch(`/api/v1/sales/${encodeURIComponent(saleId)}/urbanisme-cadastre`, {
    headers: await authHeaders(),
    cache: "no-store",
  });

  return readJson<{
    cadastralParcels: StructuredCadastralParcel[];
    urbanPlanningSignals: StructuredUrbanPlanningSignal[];
  }>(response);
}

export async function fetchValuationAdminOverview(): Promise<ValuationAdminResponse> {
  const response = await fetch("/api/admin/valuation-models", {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
  });
  return readJson<ValuationAdminResponse>(response);
}

export async function fetchEnvironmentalContext(args: {
  data: unknown;
}): Promise<EnvironmentalContextResponse> {
  const response = await fetch("/api/environment-context", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<EnvironmentalContextResponse>(response);
}

export async function calculateBidCeilingClient(args: {
  data: BidCeilingRequestInput;
}): Promise<BidCeilingAnalysisResponse> {
  const response = await fetch("/api/bid-ceiling", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<BidCeilingAnalysisResponse>(response);
}

export async function fetchSaleHistory(args: {
  saleId?: string;
  department?: string;
  city?: string;
  tribunalCode?: string;
  propertyType?: string;
  months?: number;
  limit?: number;
}): Promise<SaleHistoryResponse> {
  const params = new URLSearchParams();
  if (args.saleId) params.set("saleId", args.saleId);
  if (args.department) params.set("department", args.department);
  if (args.city) params.set("city", args.city);
  if (args.tribunalCode) params.set("tribunalCode", args.tribunalCode);
  if (args.propertyType) params.set("propertyType", args.propertyType);
  if (args.months) params.set("months", String(args.months));
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`/api/sales/history?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<SaleHistoryResponse>(response);
}

export async function fetchMarketAnalytics(args: {
  saleId?: string;
  department?: string;
  city?: string;
  tribunalCode?: string;
  propertyType?: string;
  months?: number;
  futureMonths?: number;
  limit?: number;
}): Promise<MarketAnalyticsResponse> {
  const params = new URLSearchParams();
  if (args.saleId) params.set("saleId", args.saleId);
  if (args.department) params.set("department", args.department);
  if (args.city) params.set("city", args.city);
  if (args.tribunalCode) params.set("tribunalCode", args.tribunalCode);
  if (args.propertyType) params.set("propertyType", args.propertyType);
  if (args.months) params.set("months", String(args.months));
  if (args.futureMonths != null) params.set("futureMonths", String(args.futureMonths));
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`/api/market-analytics?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<MarketAnalyticsResponse>(response);
}

export async function fetchDvfComparables(args: {
  saleId: string;
  radiusM?: number;
  months?: number;
  limit?: number;
}): Promise<DvfComparablesResponse> {
  const params = new URLSearchParams({ saleId: args.saleId });
  if (args.radiusM) params.set("radiusM", String(args.radiusM));
  if (args.months) params.set("months", String(args.months));
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`/api/dvf-comparables?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<DvfComparablesResponse>(response);
}

export async function fetchValuationBacktest(args: {
  saleId: string;
  radiusM?: number;
  months?: number;
  maxTests?: number;
}): Promise<ValuationBacktestResponse> {
  const params = new URLSearchParams({ saleId: args.saleId });
  if (args.radiusM) params.set("radiusM", String(args.radiusM));
  if (args.months) params.set("months", String(args.months));
  if (args.maxTests) params.set("maxTests", String(args.maxTests));

  const response = await fetch(`/api/valuation-backtest?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<ValuationBacktestResponse>(response);
}

export async function fetchDpeExplorer(args: {
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

  const response = await fetch(`/api/dpe/explorer?${params.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<DpeExplorerResponse>(response);
}

export async function fetchSalesStatistics(args: {
  search: SalesSearchParams;
}): Promise<SalesStatisticsResponse> {
  const params = new URLSearchParams();
  Object.entries(salesSearchToUrlRecord(args.search)).forEach(([key, value]) => {
    if (value != null && value !== "") params.set(key, String(value));
  });
  const response = await fetch(
    `/api/sales/statistics${params.size ? `?${params.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SalesStatisticsResponse>(response);
}

export async function exportSalesCsv(args: {
  search: SalesSearchParams;
}): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams();
  Object.entries(salesSearchToUrlRecord(args.search)).forEach(([key, value]) => {
    if (value != null && value !== "") params.set(key, String(value));
  });
  const url = `/api/sales/export${params.size ? `?${params.toString()}` : ""}`;
  const response = await fetch(url, {
    headers: await authHeaders(),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  const filename =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1]
      ?.trim() || "immojudis-ventes.csv";

  return {
    blob: await response.blob(),
    filename,
  };
}
