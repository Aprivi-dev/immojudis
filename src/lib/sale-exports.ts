import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import { extractDpe } from "@/lib/dpe";
import { formatDate } from "@/lib/format";
import { estimateGrossYieldPct, geocodeAddress, pricePerM2 } from "@/lib/geo";
import { featureIncluded } from "@/lib/plans";
import { computeRentabilityScore } from "@/lib/profitability";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSales } from "@/lib/queries";
import {
  applyClientSearchFilters,
  dataFiltersFromSearch,
  dataSortFromSearch,
  sortClientSearchResults,
} from "@/lib/search/search-filters";
import { salesSearchToUrlRecord, type SalesSearchParams } from "@/lib/search/search-url-state";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";

const EXPORT_SOURCE_LIMIT = 1_000;
const EXPORT_ROW_LIMIT = 500;
const API_SOURCE_LIMIT = 500;
const API_ROW_LIMIT = 100;
const API_FEED_SCHEMA_VERSION = "2026-07-judicial-sales-v1";

export type SalesCsvExport = {
  content: string;
  filename: string;
  rowCount: number;
};

export type SalesApiFeedItem = {
  id: string;
  title: string | null;
  status: string | null;
  pricing: {
    startingPriceEur: number | null;
    adjudicationPriceEur: number | null;
    pricePerM2: number | null;
  };
  audience: {
    saleDate: string | null;
    formattedSaleDate: string;
    visitDates: unknown;
  };
  location: {
    city: string | null;
    department: string | null;
    postalCode: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  tribunal: {
    code: string | null;
    name: string | null;
    city: string | null;
  };
  property: {
    type: string | null;
    occupancyStatus: string | null;
    surfaceM2: number | null;
    surfaceKind: string | null;
    rooms: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    landSurfaceM2: number | null;
  };
  energy: {
    dpe: string | null;
  };
  documents: {
    count: number;
    items: Array<{
      label: string | null;
      type: string | null;
      url: string | null;
      extractionStatus: string | null;
    }>;
  };
  risks: {
    count: number;
    top: Array<{
      type: string;
      label: string;
      severity: number | null;
      confidence: number | null;
      evidence: string | null;
      sourceDocument: string | null;
      nextAction: string | null;
    }>;
  };
  opportunity: {
    score: number | null;
    scoreConfidence: number | null;
    grossYieldPct: number | null;
    rentability: {
      score: number | null;
      label: string;
      confidencePct: number;
      netYieldPct: number | null;
      cashflowMonthly: number | null;
      breakEvenOccupancyPct: number | null;
    };
  };
  scoring: {
    version: string | null;
    confidence: number | null;
    summary: string | null;
    factors: Array<{
      key: string;
      label: string | null;
      delta: number | null;
      confidence: number | null;
      evidence: string | null;
    }>;
  };
  dataQuality: {
    surfaceConfidence: number | null;
    surfaceSource: string | null;
    dedupeConfidence: string | null;
    qualityFlags: unknown;
    sourceUpdatedAt: string | null;
  };
  source: {
    name: string | null;
    url: string | null;
    primarySource: string | null;
    urls: string[];
  };
  compliance: {
    limitations: string[];
    sourceTraceability: string;
  };
  links: {
    immojudis: string;
  };
};

export type SalesApiFeed = {
  data: SalesApiFeedItem[];
  meta: {
    schemaVersion: string;
    generatedAt: string;
    rowCount: number;
    limit: number;
    capped: boolean;
    filters: Record<string, string | number | boolean | undefined>;
    capabilities: string[];
  };
};

export async function exportSalesCsv({
  auth,
  search,
  origin,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
  origin?: string | null;
}): Promise<SalesCsvExport> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.csvExport")) {
    throw new Error("Export CSV réservé au plan Analyse.");
  }

  const sales = await resolveFilteredSales({ auth, search, sourceLimit: EXPORT_SOURCE_LIMIT });
  const rows = sales.slice(0, EXPORT_ROW_LIMIT);
  const content = buildSalesCsv(rows, origin);

  await recordSalesDataExport({
    auth,
    search,
    rowCount: rows.length,
    exportKind: "sales_csv",
  });

  return {
    content,
    filename: `immojudis-ventes-${new Date().toISOString().slice(0, 10)}.csv`,
    rowCount: rows.length,
  };
}

export async function exportSalesApiFeed({
  auth,
  search,
  origin,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
  origin?: string | null;
}): Promise<SalesApiFeed> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.apiAccess")) {
    throw new Error("API ventes réservée au plan Analyse.");
  }

  const requestedLimit = search.limit ?? API_ROW_LIMIT;
  const limit = Math.min(Math.max(1, requestedLimit), API_ROW_LIMIT);
  const sales = await resolveFilteredSales({ auth, search, sourceLimit: API_SOURCE_LIMIT });
  const rows = sales.slice(0, limit);

  await recordSalesDataExport({
    auth,
    search,
    rowCount: rows.length,
    exportKind: "sales_api",
  });

  return {
    data: buildSalesApiFeedItems(rows, origin),
    meta: {
      schemaVersion: API_FEED_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      rowCount: rows.length,
      limit,
      capped: sales.length > rows.length || requestedLimit > API_ROW_LIMIT,
      filters: salesSearchToUrlRecord(search),
      capabilities: [
        "judicial_sale_feed",
        "audience_dates",
        "tribunal",
        "pricing",
        "documents",
        "risk_signals",
        "opportunity_scoring",
        "source_traceability",
      ],
    },
  };
}

export function buildSalesCsv(sales: AuctionSale[], origin?: string | null): string {
  const headers = [
    "id",
    "titre",
    "ville",
    "departement",
    "adresse",
    "tribunal",
    "type_bien",
    "statut",
    "mise_a_prix_eur",
    "date_audience",
    "surface_m2",
    "prix_m2",
    "dpe",
    "occupation",
    "score_opportunite",
    "source",
    "url_source",
    "url_immojudis",
  ];
  const rows = sales.map((sale) => saleToCsvRow(sale, origin));
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function buildSalesApiFeedItems(
  sales: AuctionSale[],
  origin?: string | null,
): SalesApiFeedItem[] {
  return sales.map((sale) => saleToApiFeedItem(sale, origin));
}

async function resolveFilteredSales({
  auth,
  search,
  sourceLimit,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
  sourceLimit: number;
}): Promise<AuctionSale[]> {
  const center = search.aroundAddress ? await geocodeAddress(search.aroundAddress) : null;
  const sourceSales = await getSales(
    dataFiltersFromSearch(search),
    sourceLimit,
    dataSortFromSearch(search.sort),
    0,
    { client: auth.supabase },
  );

  return sortClientSearchResults(
    applyClientSearchFilters(sourceSales, search, center),
    search,
    center,
  );
}

async function recordSalesDataExport({
  auth,
  search,
  rowCount,
  exportKind,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
  rowCount: number;
  exportKind: "sales_csv" | "sales_api";
}) {
  const searchSnapshot = salesSearchToUrlRecord(search);
  const { error } = await auth.supabase.from("sale_data_exports").insert({
    user_id: auth.userId,
    export_kind: exportKind,
    search_snapshot: asJson(searchSnapshot),
    row_count: rowCount,
  });
  if (error) throw error;

  await recordFeatureUsageEvent({
    auth,
    eventKey: exportKind === "sales_csv" ? "sales.csv_exported" : "sales.api_feed_requested",
    subjectType: "sale_search",
    metadata: {
      export_kind: exportKind,
      row_count: rowCount,
      search: searchSnapshot,
      api_key_id: typeof auth.claims.api_key_id === "string" ? auth.claims.api_key_id : null,
    },
  });
}

function saleToApiFeedItem(sale: AuctionSale, origin?: string | null): SalesApiFeedItem {
  const surface = getSaleSurface(sale);
  const ppm = pricePerM2(sale.starting_price_eur, surface.value);
  const dpe = extractDpe(sale).class;
  const grossYieldPct = estimateGrossYieldPct(
    sale.starting_price_eur,
    surface.value,
    sale.department,
  );
  const rentability = computeRentabilityScore({
    surface: surface.value,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    department: sale.department,
  });
  const documents = normalizeApiDocuments(sale, origin);
  const risks = normalizeApiRisks(sale);

  return {
    id: sale.id,
    title: sale.title,
    status: sale.status,
    pricing: {
      startingPriceEur: sale.starting_price_eur,
      adjudicationPriceEur: sale.adjudication_price_eur,
      pricePerM2: ppm == null ? null : Math.round(ppm),
    },
    audience: {
      saleDate: sale.sale_date,
      formattedSaleDate: formatDate(sale.sale_date),
      visitDates: sale.visit_dates,
    },
    location: {
      city: sale.city,
      department: sale.department,
      postalCode: sale.postal_code,
      address: sale.address,
      latitude: sale.latitude,
      longitude: sale.longitude,
    },
    tribunal: {
      code: sale.tribunal_code,
      name: sale.tribunal_name ?? sale.tribunal,
      city: sale.tribunal_city,
    },
    property: {
      type: sale.property_type,
      occupancyStatus: sale.occupancy_status,
      surfaceM2: surface.value == null ? null : Math.round(surface.value * 100) / 100,
      surfaceKind: surface.kind,
      rooms: sale.rooms_count,
      bedrooms: sale.bedrooms_count,
      bathrooms: sale.bathrooms_count,
      landSurfaceM2: sale.land_surface_m2,
    },
    energy: {
      dpe,
    },
    documents: {
      count: Array.isArray(sale.documents_rich)
        ? sale.documents_rich.length
        : Array.isArray(sale.documents)
          ? sale.documents.length
          : 0,
      items: documents,
    },
    risks: {
      count: sale.risks?.length ?? 0,
      top: risks,
    },
    opportunity: {
      score: sale.investment_score,
      scoreConfidence: sale.score_confidence,
      grossYieldPct: grossYieldPct == null ? null : Math.round(grossYieldPct * 10) / 10,
      rentability: {
        score: rentability.score,
        label: rentability.label,
        confidencePct: rentability.confidencePct,
        netYieldPct: rentability.netYieldPct,
        cashflowMonthly: rentability.cashflowMonthly,
        breakEvenOccupancyPct: rentability.breakEvenOccupancyPct,
      },
    },
    scoring: {
      version: sale.score_version,
      confidence: sale.score_confidence,
      summary: sale.investment_summary,
      factors: normalizeApiScoreFactors(sale),
    },
    dataQuality: {
      surfaceConfidence: sale.surface_confidence,
      surfaceSource: sale.surface_source,
      dedupeConfidence: sale.dedupe_confidence,
      qualityFlags: sale.quality_flags,
      sourceUpdatedAt: sourceBlockText(sale, "source_updated_at", "updated_at"),
    },
    source: {
      name: sale.source_name,
      url: sale.source_url,
      primarySource: sale.primary_source,
      urls: normalizeSourceUrls(sale),
    },
    compliance: {
      limitations: [
        "Données issues de sources judiciaires collectées et normalisées par ImmoJudis.",
        "Les estimations, scores et rendements sont indicatifs et ne constituent pas une promesse de gain.",
        "Les pièces officielles, l'avocat et le cahier des conditions priment avant toute enchère.",
      ],
      sourceTraceability:
        "Le flux expose les sources et pièces disponibles sans transformer les contacts avocat source en avocats référencés.",
    },
    links: {
      immojudis: origin ? new URL(`/sales/${sale.id}`, origin).toString() : `/sales/${sale.id}`,
    },
  };
}

function normalizeApiDocuments(
  sale: AuctionSale,
  origin?: string | null,
): SalesApiFeedItem["documents"]["items"] {
  if (Array.isArray(sale.documents_rich)) {
    return sale.documents_rich.slice(0, 8).map((document) => ({
      label: document.label,
      type: document.document_type ?? document.type,
      url: toAbsoluteUrl(document.url, origin),
      extractionStatus:
        document.extraction_status ?? document.download_status ?? document.docling_status ?? null,
    }));
  }
  if (!Array.isArray(sale.documents)) return [];
  return sale.documents
    .slice(0, 8)
    .map((document) => {
      const record =
        document && typeof document === "object" ? (document as Record<string, unknown>) : {};
      return {
        label: cleanString(record.name) ?? cleanString(record.label),
        type: cleanString(record.type),
        url: toAbsoluteUrl(cleanString(record.url), origin),
        extractionStatus: null,
      };
    })
    .filter((document) => document.label || document.type || document.url);
}

function normalizeApiRisks(sale: AuctionSale): SalesApiFeedItem["risks"]["top"] {
  return [...(sale.risks ?? [])]
    .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
    .slice(0, 5)
    .map((risk) => {
      const evidence = risk.evidence_json;
      const evidenceRecord =
        evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>) : {};
      const occurrence = risk.occurrences?.[0] ?? null;
      return {
        type: risk.risk_type,
        label: risk.risk_label,
        severity: risk.severity,
        confidence: risk.confidence ?? occurrence?.confidence ?? null,
        evidence: risk.evidence,
        sourceDocument:
          occurrence?.document_label ??
          cleanString(evidenceRecord.document_label) ??
          cleanString(evidenceRecord.document_type),
        nextAction:
          cleanString(evidenceRecord.next_action) ?? cleanString(evidenceRecord.why_it_matters),
      };
    });
}

function normalizeApiScoreFactors(sale: AuctionSale): SalesApiFeedItem["scoring"]["factors"] {
  return (sale.score_factors ?? [])
    .slice()
    .sort((a, b) => (a.factor_order ?? 999) - (b.factor_order ?? 999))
    .slice(0, 8)
    .map((factor) => ({
      key: factor.factor_key,
      label: factor.label,
      delta: factor.delta,
      confidence: factor.confidence ?? null,
      evidence: factor.evidence ?? cleanString(factor.raw_value),
    }));
}

function normalizeSourceUrls(sale: AuctionSale): string[] {
  return compactStrings([
    sale.source_url,
    ...(Array.isArray(sale.source_urls) ? sale.source_urls : []),
  ]).slice(0, 8);
}

function sourceBlockText(sale: AuctionSale, ...keys: string[]): string | null {
  const blocks = sale.source_blocks ?? {};
  for (const key of keys) {
    const value = blocks[key];
    const text = cleanString(value);
    if (text) return text;
  }
  return null;
}

function toAbsoluteUrl(value: string | null | undefined, origin?: string | null): string | null {
  const text = cleanString(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (!origin) return text;
  try {
    return new URL(text, origin).toString();
  } catch {
    return text;
  }
}

function compactStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  return values.map(cleanString).filter((value): value is string => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function cleanString(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
  }
  return null;
}

function saleToCsvRow(sale: AuctionSale, origin?: string | null): Array<string | number | null> {
  const surface = getSaleSurface(sale).value;
  const ppm = pricePerM2(sale.starting_price_eur, surface);
  const dpe = extractDpe(sale).class;

  return [
    sale.id,
    sale.title,
    sale.city,
    sale.department,
    sale.address,
    sale.tribunal_name ?? sale.tribunal,
    sale.property_type,
    sale.status,
    sale.starting_price_eur,
    formatDate(sale.sale_date),
    surface == null ? null : Math.round(surface * 100) / 100,
    ppm == null ? null : Math.round(ppm),
    dpe,
    sale.occupancy_status,
    sale.investment_score,
    sale.source_name ?? sale.primary_source,
    sale.source_url,
    origin ? new URL(`/sales/${sale.id}`, origin).toString() : `/sales/${sale.id}`,
  ];
}

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  const text = String(value).replace(/\r?\n/g, " ").trim();
  if (!/[",\n;]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function asJson(value: unknown): Json {
  return value as Json;
}
