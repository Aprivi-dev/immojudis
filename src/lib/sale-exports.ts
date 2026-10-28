import "server-only";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { extractDpe } from "@/lib/dpe";
import { formatDate } from "@/lib/format";
import { estimateSaleGrossYieldPct, geocodeAddress, pricePerM2 } from "@/lib/geo";
import { saleYieldFeeOptions } from "@/lib/sale-yield-fees";
import { isRentApplicable, type RentLookup } from "@/lib/rent-reference";
import {
  isAnilRentReference,
  RENT_ATTRIBUTION,
  RENT_SOURCE_URL,
  rentSourceDetail,
} from "@/lib/rent-source-notice";
import {
  createRentLookupSession,
  rentBasisOf,
  type RentBasis,
  type RentLookupSession,
} from "@/lib/rent-reference.server";
import { cleanDateForListing } from "@/lib/listing-data-cleanup";
import { featureIncluded } from "@/lib/plans";
import { computeAcquisitionCosts, computeRentabilityScore } from "@/lib/profitability";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSales } from "@/lib/queries";
import { RateLimitError } from "@/lib/api-errors";
import {
  enforceDailyOperationLimits,
  enforceUserRateLimit,
  secondsUntilWindowEnds,
} from "@/lib/rate-limit";
import {
  DAILY_LIMIT_MESSAGE,
  DAILY_WINDOW_SECONDS,
  SALES_API_FEED_DAILY_ROWS,
  SALES_CSV_EXPORT_DAILY_ROWS,
} from "@/lib/rate-limit-policies";
import { cleanSaleTitle } from "@/lib/sale-title";
import {
  applyClientSearchFilters,
  dataFiltersFromSearch,
  dataSortFromSearch,
  sortClientSearchResults,
} from "@/lib/search/search-filters";
import { salesSearchToUrlRecord, type SalesSearchParams } from "@/lib/search/search-url-state";
import { listPepiteSaleIds } from "@/lib/pepite-sale-ids";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { getPublicationVisibleSaleIds } from "@/lib/sale-publication-guard";

const EXPORT_SOURCE_LIMIT = 1_000;
const EXPORT_ROW_LIMIT = 500;
const API_SOURCE_LIMIT = 500;
const API_ROW_LIMIT = 100;
/**
 * Version du schéma du flux. Montée le 27/10/2026 : le SENS de `opportunity.grossYieldPct` et de `rentability.*`
 * change (loyers de la carte ANIL à la commune, charges comprises, au lieu du repère départemental ; frais du régime
 * de la vente au lieu de ceux du tribunal ; plus de rendement pour un bien qui n'est pas un logement). Les champs et
 * leurs types ne changent pas ; la note est dans `meta.changes`.
 */
const API_FEED_SCHEMA_VERSION = "2026-10-judicial-sales-v1";

/** Changements de sens depuis la version précédente du schéma (`2026-07-judicial-sales-v1`), pour le client. */
const API_FEED_CHANGES: readonly string[] = [
  "2026-10 : opportunity.grossYieldPct et rentability.* partent des loyers de la carte ANIL à la commune (loyers d'annonce, charges comprises) et non plus du repère départemental ; opportunity.rentReference et meta.rentBasis disent quelle source a servi.",
  "2026-10 : le rendement est calculé avec les frais du type de vente (tribunal, vente à la bougie, vente interactive) et non plus avec ceux du tribunal pour toutes les ventes.",
  "2026-10 : un bien qui n'est pas un logement (terrain, parking, local, lot mixte ou divers) n'a plus de rendement (null) ; un type inconnu n'en a que si la vente publie une surface.",
];

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
    /**
     * Loyer derrière le rendement : carte des loyers de l'ANIL (loyer d'annonce, charges comprises) ou
     * repli départemental. `null` quand aucun loyer de référence n'existe.
     */
    rentReference: {
      source: string;
      reliability: string;
      rentPerM2: number;
      vintage: number | null;
      sourceUpdatedOn: string | null;
      /** Mention obligatoire de la Licence Ouverte 2.0 ; `null` hors données ANIL. */
      attribution: string | null;
      attributionDetail: string | null;
      /** Vrai pour un loyer ANIL : loyer d'annonce charges comprises, donc rendements bruts, charges comprises. */
      chargesIncluded: boolean;
      sourceUrl: string | null;
    } | null;
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
    /** Mention obligatoire de la carte des loyers de l'ANIL, à reproduire avec les rendements. */
    rentAttribution: string;
    rentSourceUrl: string;
    /** Ce que les rendements des lignes utilisent : carte de l'ANIL, repère départemental, ou les deux. */
    rentBasis: RentBasis;
    /** Changements de sens des champs depuis la version précédente du schéma. */
    changes: string[];
  };
};

export async function exportSalesCsv({
  auth,
  search,
  origin,
  request,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
  origin?: string | null;
  /** Requête HTTP d'origine : sert au plafond journalier par adresse. */
  request: Request;
}): Promise<SalesCsvExport> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.csvExport")) {
    throw new Error("Export CSV réservé à l’offre Analyse.");
  }
  await enforceUserRateLimit({
    userId: auth.userId,
    bucketKey: "sales.csv_export",
    limit: 6,
    windowSeconds: 60,
  });
  // Après le droit d'accès : seul un compte qui y a droit use les compteurs de son adresse et le
  // disjoncteur global. Puis le plafond de lignes du jour : chaque ligne porte une adresse.
  await enforceDailyOperationLimits({
    request,
    userId: auth.userId,
    operation: "salesCsvExport",
    launchOffer: plan.launchOffer === true,
  });
  const rowBudget = await remainingDailyExportRows(auth, "sales_csv", SALES_CSV_EXPORT_DAILY_ROWS);

  const { sales } = await resolveFilteredSales({
    auth,
    search,
    sourceLimit: EXPORT_SOURCE_LIMIT,
    rentSession: createRentLookupSession(),
  });
  const rows = sales.slice(0, Math.min(EXPORT_ROW_LIMIT, rowBudget));
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
  request,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
  origin?: string | null;
  /** Requête HTTP d'origine : sert au plafond journalier par adresse. */
  request: Request;
}): Promise<SalesApiFeed> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.apiAccess")) {
    throw new Error("API ventes réservée à l’offre Analyse.");
  }
  await enforceUserRateLimit({
    userId: auth.userId,
    bucketKey: "sales.api_feed",
    limit: 60,
    windowSeconds: 60,
  });
  await enforceDailyOperationLimits({
    request,
    userId: auth.userId,
    operation: "salesApiFeed",
    launchOffer: plan.launchOffer === true,
  });
  const rowBudget = await remainingDailyExportRows(auth, "sales_api", SALES_API_FEED_DAILY_ROWS);

  const requestedLimit = search.limit ?? API_ROW_LIMIT;
  const limit = Math.min(Math.max(1, requestedLimit), API_ROW_LIMIT, rowBudget);
  const rentSession = createRentLookupSession();
  const { sales } = await resolveFilteredSales({
    auth,
    search,
    sourceLimit: API_SOURCE_LIMIT,
    rentSession,
  });
  const rows = sales.slice(0, limit);
  // Loyers de la carte ANIL à la commune, pour les seules lignes rendues.
  const rents = await rentSession.load(rows);

  await recordSalesDataExport({
    auth,
    search,
    rowCount: rows.length,
    exportKind: "sales_api",
  });

  return {
    data: buildSalesApiFeedItems(rows, origin, rents),
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
      rentAttribution: RENT_ATTRIBUTION,
      rentSourceUrl: RENT_SOURCE_URL,
      rentBasis: rentBasisOf(rows, rents),
      changes: [...API_FEED_CHANGES],
    },
  };
}

/**
 * Lignes que le compte peut encore exporter aujourd'hui (jour UTC, comme les plafonds du nombre
 * d'appels) : le plafond, moins les lignes déjà inscrites dans `sale_data_exports` pour ce type
 * d'export. À zéro, la demande est refusée (429, message quotidien). Deux exports simultanés peuvent
 * dépasser le reste de quelques lignes : le nombre d'appels par minute et par jour borne l'écart.
 */
async function remainingDailyExportRows(
  auth: SupabaseAuthContext,
  exportKind: "sales_csv" | "sales_api",
  dailyRows: number,
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabaseAdmin
    .from("sale_data_exports")
    .select("row_count")
    .eq("user_id", auth.userId)
    .eq("export_kind", exportKind)
    .gte("created_at", startOfDay.toISOString())
    .limit(1_000);
  if (error) throw error;
  const used = (data ?? []).reduce((sum, row) => sum + Math.max(0, row.row_count ?? 0), 0);
  const remaining = dailyRows - used;
  if (remaining <= 0) {
    throw new RateLimitError(
      undefined,
      secondsUntilWindowEnds(DAILY_WINDOW_SECONDS),
      DAILY_LIMIT_MESSAGE,
    );
  }
  return remaining;
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
  rents?: RentLookup,
): SalesApiFeedItem[] {
  return sales.map((sale) => saleToApiFeedItem(sale, origin, rents));
}

/**
 * Identifiants des ventes dont la mise à prix est sous la fourchette (`list_public_sale_ids_under_market_range`,
 * liste publique). Une panne est levée : le flux ne répond jamais « aucune vente » à la place de la liste.
 */
async function listUnderRangeSaleIds(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin.rpc("list_public_sale_ids_under_market_range");
  if (error) throw error;
  return new Set(
    (Array.isArray(data) ? data : [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.toLowerCase()),
  );
}

async function resolveFilteredSales({
  auth,
  search,
  sourceLimit,
  rentSession,
}: {
  auth: SupabaseAuthContext;
  search: SalesSearchParams;
  sourceLimit: number;
  /** Session de loyers de la requête : les lectures du filtre et des lignes rendues sont partagées. */
  rentSession: RentLookupSession;
}): Promise<{ sales: AuctionSale[]; rents: RentLookup | undefined }> {
  const center = search.aroundAddress ? await geocodeAddress(search.aroundAddress) : null;
  // Le tri de l'URL s'applique aussi aux exports: par défaut (« Mieux renseignées d'abord »),
  // l'échantillon plafonné par `sourceLimit` suit donc l'ordre par complétude puis par date.
  const sourceSales = await getSales(
    dataFiltersFromSearch(search),
    sourceLimit,
    dataSortFromSearch(search.sort, { allowInvestmentScore: true }),
    0,
    { client: auth.supabase },
  );
  // API-key requests use the service-role client so the key can be resolved
  // without a user JWT. Apply the publication gate after that privileged
  // read and before filtering, pagination, or serialization.
  const visibleSaleIds = await getPublicationVisibleSaleIds(sourceSales.map((sale) => sale.id));
  const visibleSourceSales = sourceSales.filter((sale) => visibleSaleIds.has(sale.id));

  // Loyers de la carte ANIL à la commune, lus avant le filtre « rendement minimal » (côté serveur : le
  // navigateur n'en reçoit pas).
  const rents = search.minYield != null ? await rentSession.load(visibleSourceSales) : undefined;
  // « Pépites seulement » et « sous la fourchette » se croisent avec leur liste publique d'identifiants, comme la
  // recherche : sans elle, le filtre ne passe aucune vente (`applyClientSearchFilters`) et le flux répondait 200 vide.
  // Une liste illisible lève au lieu de rendre « aucune vente ».
  const [pepiteSaleIds, underRangeSaleIds] = await Promise.all([
    search.pepite
      ? listPepiteSaleIds({ rpc: (fn) => supabaseAdmin.rpc(fn) }).then((ids) => new Set(ids))
      : null,
    search.belowRange ? listUnderRangeSaleIds() : null,
  ]);
  const sales = sortClientSearchResults(
    applyClientSearchFilters(visibleSourceSales, search, center, {
      rents,
      pepiteSaleIds,
      underRangeSaleIds,
    }),
    search,
    center,
  );
  return { sales, rents };
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
  const { error } = await supabaseAdmin.from("sale_data_exports").insert({
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

function saleToApiFeedItem(
  sale: AuctionSale,
  origin?: string | null,
  rents?: RentLookup,
): SalesApiFeedItem {
  const rentReference = isRentApplicable(sale) ? (rents?.(sale) ?? null) : null;
  const surface = getSaleSurface(sale);
  const ppm = pricePerM2(sale.starting_price_eur, surface.value);
  const dpe = extractDpe(sale).class;
  const grossYieldPct = estimateSaleGrossYieldPct(sale, surface.value, rentReference);
  const rentability = computeRentabilityScore({
    surface: surface.value,
    price: Math.max(0, sale.starting_price_eur ?? 0),
    // Frais du régime de la vente (comme le rendement brut et le rapport), non ceux du tribunal.
    acquisition: computeAcquisitionCosts({
      ...saleYieldFeeOptions(sale),
      price: Math.max(0, sale.starting_price_eur ?? 0),
      department: isRentApplicable(sale) ? sale.department : null,
    }),
    // Un bien qui n'est pas un logement n'a aucun loyer de référence : « indisponible ».
    department: isRentApplicable(sale) ? sale.department : null,
    rentReference,
  });
  const documents = normalizeApiDocuments(sale, origin);
  const risks = normalizeApiRisks(sale);

  return {
    id: sale.id,
    title: cleanSaleTitle(sale.title),
    status: sale.status,
    pricing: {
      startingPriceEur: sale.starting_price_eur,
      adjudicationPriceEur: sale.adjudication_price_eur,
      pricePerM2: ppm == null ? null : Math.round(ppm),
    },
    audience: {
      // A date-only sale is stored at UTC midnight: export the day, not a 01:00/02:00 hour that never existed.
      saleDate: cleanDateForListing(sale.sale_date),
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
      rentReference: rentReference
        ? {
            source: rentReference.source,
            reliability: rentReference.reliability,
            rentPerM2: rentReference.rentPerM2,
            vintage: rentReference.vintage ?? null,
            sourceUpdatedOn: rentReference.sourceUpdatedOn ?? null,
            attribution: isAnilRentReference(rentReference) ? RENT_ATTRIBUTION : null,
            attributionDetail: rentSourceDetail(rentReference),
            chargesIncluded: isAnilRentReference(rentReference),
            sourceUrl: isAnilRentReference(rentReference) ? RENT_SOURCE_URL : null,
          }
        : null,
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
        "Données issues de sources judiciaires collectées et normalisées par Immojudis.",
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
    cleanSaleTitle(sale.title),
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
  const normalized = String(value).replace(/\r?\n/g, " ").trim();
  const text =
    typeof value === "string" && /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  if (!/[",\n;]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function asJson(value: unknown): Json {
  return value as Json;
}
