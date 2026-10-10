import "server-only";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeEmail } from "@/lib/account";
import { extractDpe } from "@/lib/dpe";
import { DETAIL_VIEW } from "@/lib/queries";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { getSaleSurface } from "@/lib/surface";
import { joinColumns } from "@/lib/supabase-select";
import type { AuctionSale } from "@/lib/types";

// Leave headroom below PostgREST's statement timeout while workers are active.
const DATA_QUALITY_PAGE_SIZE = 250;

/**
 * Keep the quality scan independent from the catalogue/detail projection.
 * The latter also evaluates media, score factors, source checks and full text
 * fields that no quality metric reads, which can make a paginated scan time
 * out on the app view's lateral aggregations.
 */
export const DATA_QUALITY_SALE_COLUMNS = [
  "sale_procedure",
  "sale_venue_type",
  "sale_legal_framework",
  "sale_verification_status",
  "id",
  "title",
  "city",
  "department",
  "tribunal",
  "tribunal_code",
  "tribunal_name",
  "tribunal_city",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "latitude",
  "longitude",
  "occupancy_status",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "rooms_count",
  "score_confidence",
  "risk_notes",
  "risks",
  "documents",
  "documents_rich",
  "source_name",
  "source_url",
  "primary_source",
  "source_urls",
  "source_blocks",
  "llm_display_description",
  "lawyer_name",
  "lawyer_contact",
  "status",
  "updated_at",
] as const;

const DATA_QUALITY_SALE_SELECT = joinColumns(DATA_QUALITY_SALE_COLUMNS);

export type DataQualityStatus = "healthy" | "watch" | "critical";

export type DataQualityPrioritySale = Pick<
  AuctionSale,
  "id" | "title" | "city" | "property_type" | "score_confidence"
> & { flags: string[] };

export type DataQualityMetric = {
  key: string;
  label: string;
  count: number;
  total: number;
  pct: number;
  status: DataQualityStatus;
  productImpact: string;
  nextAction: string;
};

export type DataQualitySourceCoverage = {
  source: string;
  count: number;
  sharePct: number;
  missingLocation: number;
  missingSurface: number;
  missingDocuments: number;
  missingRichDocuments: number;
  missingAiDescription: number;
  missingOccupation: number;
  missingConfidence: number;
  averageConfidencePct: number | null;
  weakCount: number;
};

export type DataQualityFreshness = {
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  lastRunStatus: string | null;
  hoursSinceLastSuccessfulRun: number | null;
  activeSales: number;
  staleActiveSales: number;
  freshnessStatus: DataQualityStatus;
};

export type DataQualityReport = {
  checkedAt: string;
  adminEmail: string;
  sampleSize: number;
  sourceLimit: number;
  capped: boolean;
  averageConfidencePct: number | null;
  highConfidenceCount: number;
  richDocumentsCount: number;
  occupationCount: number;
  riskSales: number;
  sourcedRiskSales: number;
  overallStatus: DataQualityStatus;
  freshness: DataQualityFreshness;
  capabilities: DataQualityMetric[];
  fields: DataQualityMetric[];
  sourceCoverage: DataQualitySourceCoverage[];
  priorityGaps: DataQualityMetric[];
  prioritySales: DataQualityPrioritySale[];
};

type AdminContext = {
  userId: string;
  claims?: Record<string, unknown>;
  isAdmin: boolean;
};

type AuctionRunRow = {
  status?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export async function getDataQualityReport(authToken: string): Promise<DataQualityReport> {
  const context = await requireSupabaseAuthContext(authToken);
  const adminEmail = assertAdmin(context as AdminContext);
  const [sales, runs] = await Promise.all([loadAllSales(), loadRecentRuns()]);

  return buildDataQualityReport({
    sales,
    runs,
    adminEmail,
    capped: false,
  });
}

export function buildDataQualityReport({
  sales,
  runs = [],
  adminEmail = "admin",
  now = new Date(),
  sourceLimit = DATA_QUALITY_PAGE_SIZE,
  capped,
}: {
  sales: AuctionSale[];
  runs?: AuctionRunRow[];
  adminEmail?: string;
  now?: Date;
  sourceLimit?: number;
  capped?: boolean;
}): DataQualityReport {
  const fields = buildFieldMetrics(sales);
  const capabilities = buildCapabilityMetrics(sales);
  const freshness = buildFreshness({ sales, runs, now });
  const allStatuses = [...fields, ...capabilities].map((metric) => metric.status);
  const overallStatus: DataQualityStatus =
    freshness.freshnessStatus === "critical" || allStatuses.includes("critical")
      ? "critical"
      : freshness.freshnessStatus === "watch" || allStatuses.includes("watch")
        ? "watch"
        : "healthy";

  return {
    checkedAt: now.toISOString(),
    adminEmail,
    sampleSize: sales.length,
    sourceLimit,
    capped: capped ?? sales.length >= sourceLimit,
    averageConfidencePct: averageConfidencePct(sales),
    highConfidenceCount: sales.filter((sale) => (sale.score_confidence ?? 0) >= 0.7).length,
    richDocumentsCount: sales.filter(
      (sale) => Array.isArray(sale.documents_rich) && sale.documents_rich.length > 0,
    ).length,
    occupationCount: sales.filter((sale) =>
      Boolean(sale.occupancy_status && sale.occupancy_status !== "unknown"),
    ).length,
    riskSales: sales.filter((sale) => (sale.risks?.length ?? 0) > 0).length,
    sourcedRiskSales: sales.filter((sale) =>
      (sale.risks ?? []).some((risk) => risk.evidence || risk.occurrences?.[0]?.excerpt),
    ).length,
    overallStatus,
    freshness,
    capabilities,
    fields,
    sourceCoverage: buildSourceCoverage(sales),
    prioritySales: buildPrioritySales(sales),
    priorityGaps: [...capabilities, ...fields]
      .filter((metric) => metric.status !== "healthy")
      .sort((a, b) => statusWeight(b.status) - statusWeight(a.status) || a.pct - b.pct)
      .slice(0, 8),
  };
}

function buildPrioritySales(sales: AuctionSale[]): DataQualityPrioritySale[] {
  const dateOrder = (sale: AuctionSale) => {
    const timestamp = Date.parse(sale.sale_date ?? "");
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
  };

  // Reuse the authenticated report scan; a second full catalogue projection
  // would evaluate expensive joins just to display twelve compact summaries.
  return [...sales]
    .sort((a, b) => dateOrder(a) - dateOrder(b) || a.id.localeCompare(b.id))
    .slice(0, 500)
    .map((sale) => {
      const flags: string[] = [];
      if ((sale.score_confidence ?? 0) < 0.55) flags.push("confiance faible");
      if (!sale.llm_display_description?.trim()) flags.push("synthèse IA absente");
      if (!sale.documents_rich?.length) {
        flags.push(hasDocuments(sale) ? "documents non enrichis" : "documents manquants");
      }
      if (!hasSurface(sale)) flags.push("surface absente");
      if (!sale.occupancy_status || sale.occupancy_status === "unknown") flags.push("occupation");
      return {
        id: sale.id,
        title: sale.title,
        city: sale.city,
        property_type: sale.property_type,
        score_confidence: sale.score_confidence,
        flags,
      };
    })
    .filter((sale) => sale.flags.length > 0)
    .slice(0, 12);
}

function assertAdmin(context: AdminContext): string {
  if (!context.isAdmin) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }

  const email = typeof context.claims?.email === "string" ? context.claims.email : null;
  return normalizeEmail(email) || "admin";
}

function buildFieldMetrics(sales: AuctionSale[]): DataQualityMetric[] {
  return [
    metric({
      key: "sale_procedure",
      label: "Procédure de vente vérifiée",
      sales,
      predicate: hasVerifiedSaleProcedure,
      productImpact:
        "Conditionne le lieu de vente, le recours à un avocat, la consignation et les délais affichés au visiteur.",
      nextAction:
        "Rapprocher l'annonce, les pièces et le référentiel officiel avant de publier une qualification définitive.",
      warningPct: 90,
      healthyPct: 98,
    }),
    metric({
      key: "ai_description",
      label: "Synthèse IA publique",
      sales,
      predicate: hasAiDisplayDescription,
      productImpact:
        "Conditionne la clarté des fiches annonces : aucune description brute source ne doit remplacer la synthèse IA.",
      nextAction:
        "Relancer l'enrichissement LLM display_description pour les annonces sans llm_display_description.",
      warningPct: 95,
      healthyPct: 99,
    }),
    metric({
      key: "location",
      label: "Coordonnées BAN",
      sales,
      predicate: hasLocation,
      productImpact:
        "Nécessaire aux cartes, comparables par rayon, services proches et API enrichie.",
      nextAction: "Relancer le géocodage BAN pour les ventes sans latitude/longitude.",
    }),
    metric({
      key: "surface",
      label: "Surface exploitable",
      sales,
      predicate: hasSurface,
      productImpact: "Conditionne le prix au m², les comparables, le rendement et le plafond.",
      nextAction: "Prioriser extraction PDF/LLM des surfaces et preuves associées.",
    }),
    metric({
      key: "documents",
      label: "Documents judiciaires",
      sales,
      predicate: hasDocuments,
      productImpact:
        "Alimente les risques, occupation, checklist, traces source et revue juridique.",
      nextAction: "Télécharger/qualifier les pièces publiques manquantes.",
    }),
    metric({
      key: "dpe",
      label: "Signal DPE",
      sales,
      predicate: hasDpeSignal,
      productImpact: "Débloque explorateur DPE, filtres DPE et scoring énergétique.",
      nextAction: "Extraire DPE depuis diagnostics et blocs source.",
    }),
    metric({
      key: "cadastre",
      label: "Signal cadastre/parcelle",
      sales,
      predicate: hasCadastreSignal,
      productImpact: "Sécurise fiche cadastrale, limites, parcelle et points juridiques.",
      nextAction: "Repérer les plans cadastraux et mentions de parcelle dans les pièces.",
    }),
    metric({
      key: "source_traceability",
      label: "Traçabilité source",
      sales,
      predicate: hasSourceTrace,
      productImpact: "Indispensable pour rapports payants, API et conformité.",
      nextAction: "Conserver URL primaire, source et dates de capture pour chaque vente.",
    }),
  ];
}

function buildCapabilityMetrics(sales: AuctionSale[]): DataQualityMetric[] {
  return [
    metric({
      key: "opportunity_report",
      label: "Rapport d'opportunité complet",
      sales,
      predicate: (sale) =>
        hasPrice(sale) &&
        hasAudienceDate(sale) &&
        hasSurface(sale) &&
        hasLocation(sale) &&
        hasSourceTrace(sale),
      productImpact: "Base de l'offre Analyse : estimation, décote, frais, risques et score.",
      nextAction: "Combler en priorité prix, audience, surface, coordonnées et source.",
      warningPct: 75,
      healthyPct: 90,
    }),
    metric({
      key: "market_estimate",
      label: "Estimation marché par comparables",
      sales,
      predicate: (sale) => hasLocation(sale) && hasSurface(sale),
      productImpact: "Permet DVF/comparables, valeur marché et décote apparente.",
      nextAction: "Géocoder et extraire les surfaces avant d'étendre les comparables DVF.",
      warningPct: 70,
      healthyPct: 88,
    }),
    metric({
      key: "dvf_detailed_comparables",
      label: "Comparables DVF détaillés",
      sales,
      predicate: (sale) =>
        hasLocation(sale) &&
        hasSurface(sale) &&
        Boolean(sale.department || sale.city) &&
        Boolean(sale.property_type),
      productImpact:
        "Alimente l'API Analyse : ranking distance/récence/surface/type et fourchette défendable.",
      nextAction: "Normaliser type, zone, surface et coordonnées avant l'import DVF semestriel.",
      warningPct: 70,
      healthyPct: 88,
    }),
    metric({
      key: "bid_ceiling",
      label: "Calcul d’enchère plafond",
      sales,
      predicate: (sale) => hasPrice(sale) && hasSurface(sale),
      productImpact: "Rend le simulateur actionnable avant audience.",
      nextAction: "Consolider mise à prix et surface utile.",
      warningPct: 80,
      healthyPct: 92,
    }),
    metric({
      key: "smart_alerts",
      label: "Alertes data-driven",
      sales,
      predicate: (sale) =>
        hasPrice(sale) &&
        hasAudienceDate(sale) &&
        Boolean(sale.city || sale.department) &&
        Boolean(sale.property_type),
      productImpact: "Conditionne alertes par budget, zone, type, rendement et audience.",
      nextAction: "Compléter zone, type de bien, prix et date d'audience.",
      warningPct: 80,
      healthyPct: 94,
    }),
    metric({
      key: "investor_api_feed",
      label: "API ventes judiciaires enrichies",
      sales,
      predicate: (sale) =>
        hasSourceTrace(sale) &&
        hasPrice(sale) &&
        hasAudienceDate(sale) &&
        Boolean(sale.tribunal || sale.tribunal_name || sale.tribunal_code),
      productImpact: "Défend l'offre API payante par donnée judiciaire enrichie et traçable.",
      nextAction: "Compléter tribunal, source, audience et mise à prix.",
      warningPct: 80,
      healthyPct: 94,
    }),
  ];
}

function buildFreshness({
  sales,
  runs,
  now,
}: {
  sales: AuctionSale[];
  runs: AuctionRunRow[];
  now: Date;
}): DataQualityFreshness {
  const sortedRuns = [...runs].sort((a, b) => runTime(b) - runTime(a));
  const lastRun = sortedRuns[0] ?? null;
  const lastSuccessful = sortedRuns.find((run) => run.status === "succeeded") ?? null;
  const hoursSinceLastSuccessfulRun = lastSuccessful
    ? hoursBetween(runDate(lastSuccessful), now)
    : null;
  const activeSales = sales.filter(isActiveOrUpcoming).length;
  const staleActiveSales = sales.filter(
    (sale) => isActiveOrUpcoming(sale) && isSaleStale(sale, now),
  ).length;
  const freshnessStatus: DataQualityStatus =
    hoursSinceLastSuccessfulRun == null || hoursSinceLastSuccessfulRun > 72
      ? "critical"
      : hoursSinceLastSuccessfulRun > 36 || pct(staleActiveSales, activeSales) >= 25
        ? "watch"
        : "healthy";

  return {
    lastRunAt: lastRun ? runDate(lastRun).toISOString() : null,
    lastSuccessfulRunAt: lastSuccessful ? runDate(lastSuccessful).toISOString() : null,
    lastRunStatus: lastRun?.status ?? null,
    hoursSinceLastSuccessfulRun,
    activeSales,
    staleActiveSales,
    freshnessStatus,
  };
}

function buildSourceCoverage(sales: AuctionSale[]): DataQualitySourceCoverage[] {
  const groups = new Map<string, AuctionSale[]>();
  for (const sale of sales) {
    const source = sale.primary_source || sale.source_name || "Source inconnue";
    groups.set(source, [...(groups.get(source) ?? []), sale]);
  }

  return [...groups.entries()]
    .map(([source, items]) => ({
      source,
      count: items.length,
      sharePct: pct(items.length, sales.length),
      missingLocation: items.filter((sale) => !hasLocation(sale)).length,
      missingSurface: items.filter((sale) => !hasSurface(sale)).length,
      missingDocuments: items.filter((sale) => !hasDocuments(sale)).length,
      missingRichDocuments: items.filter(
        (sale) => !Array.isArray(sale.documents_rich) || sale.documents_rich.length === 0,
      ).length,
      missingAiDescription: items.filter((sale) => !hasAiDisplayDescription(sale)).length,
      missingOccupation: items.filter(
        (sale) => !sale.occupancy_status || sale.occupancy_status === "unknown",
      ).length,
      missingConfidence: items.filter((sale) => typeof sale.score_confidence !== "number").length,
      averageConfidencePct: averageConfidencePct(items),
      weakCount: items.filter(isWeakSale).length,
    }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .slice(0, 12);
}

function metric({
  key,
  label,
  sales,
  predicate,
  productImpact,
  nextAction,
  warningPct = 65,
  healthyPct = 85,
}: {
  key: string;
  label: string;
  sales: AuctionSale[];
  predicate: (sale: AuctionSale) => boolean;
  productImpact: string;
  nextAction: string;
  warningPct?: number;
  healthyPct?: number;
}): DataQualityMetric {
  const count = sales.filter(predicate).length;
  const value = pct(count, sales.length);
  return {
    key,
    label,
    count,
    total: sales.length,
    pct: value,
    status: value >= healthyPct ? "healthy" : value >= warningPct ? "watch" : "critical",
    productImpact,
    nextAction,
  };
}

async function loadAllSales(): Promise<AuctionSale[]> {
  const sales: AuctionSale[] = [];

  for (let from = 0; ; from += DATA_QUALITY_PAGE_SIZE) {
    const to = from + DATA_QUALITY_PAGE_SIZE - 1;
    // Bound the input before the view evaluates visibility and lateral joins.
    // LIMIT on the view alone can sort/aggregate the whole catalogue first.
    const { data: candidates, error: candidateError } = await supabaseAdmin
      .from("auction_sales")
      .select("id")
      .order("id", { ascending: true })
      .range(from, to);
    if (candidateError) throw candidateError;
    const ids = (candidates ?? []).map((sale) => sale.id);
    if (ids.length === 0) return sales;

    const { data, error } = await supabaseAdmin
      .from(DETAIL_VIEW)
      .select(DATA_QUALITY_SALE_SELECT)
      .in("id", ids);

    if (error) throw error;
    const page = (data ?? []) as AuctionSale[];
    sales.push(...page);
    // A full candidate batch can contain no visible sales. Continue scanning.
    if (ids.length < DATA_QUALITY_PAGE_SIZE) return sales;
  }
}

async function loadRecentRuns(): Promise<AuctionRunRow[]> {
  const { data, error } = await supabaseAdmin
    .from("auction_runs")
    .select("status,started_at,finished_at,created_at,updated_at")
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(20);

  if (error) throw error;
  return data ?? [];
}

function hasLocation(sale: AuctionSale): boolean {
  return finite(sale.latitude) && finite(sale.longitude);
}

function hasSurface(sale: AuctionSale): boolean {
  const surface = getSaleSurface(sale).value;
  return typeof surface === "number" && Number.isFinite(surface) && surface > 0;
}

function hasPrice(sale: AuctionSale): boolean {
  return finite(sale.starting_price_eur) && (sale.starting_price_eur ?? 0) > 0;
}

function hasAudienceDate(sale: AuctionSale): boolean {
  return Boolean(sale.sale_date && Number.isFinite(Date.parse(sale.sale_date)));
}

function hasDocuments(sale: AuctionSale): boolean {
  return (
    (Array.isArray(sale.documents_rich) && sale.documents_rich.length > 0) ||
    (Array.isArray(sale.documents) && sale.documents.length > 0) ||
    Boolean(sale.documents && typeof sale.documents === "object")
  );
}

function hasDpeSignal(sale: AuctionSale): boolean {
  const dpe = extractDpe(sale);
  return Boolean(dpe.class || dpe.label);
}

function hasCadastreSignal(sale: AuctionSale): boolean {
  const texts = [
    sale.risk_notes,
    JSON.stringify(sale.source_blocks ?? {}),
    ...(sale.documents_rich ?? []).flatMap((document) => [
      document.label,
      document.type,
      document.document_type,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /cadastre|cadastral|parcelle|section cadastrale|plan/.test(texts);
}

function hasSourceTrace(sale: AuctionSale): boolean {
  return Boolean(sale.source_url || sale.primary_source || sale.source_name || sale.source_urls);
}

function hasVerifiedSaleProcedure(sale: AuctionSale): boolean {
  const procedure = getSaleProcedure(sale);
  return (
    procedure.procedure != null &&
    (procedure.verificationStatus === "verified" ||
      procedure.verificationStatus === "cross_checked")
  );
}

function hasAiDisplayDescription(sale: AuctionSale): boolean {
  return Boolean(sale.llm_display_description?.trim());
}

function isWeakSale(sale: AuctionSale): boolean {
  return (
    (sale.score_confidence ?? 0) < 0.55 ||
    !hasAiDisplayDescription(sale) ||
    !hasSurface(sale) ||
    !hasDocuments(sale) ||
    !sale.occupancy_status ||
    sale.occupancy_status === "unknown"
  );
}

function isActiveOrUpcoming(sale: AuctionSale): boolean {
  return sale.status === "active" || sale.status === "upcoming";
}

function isSaleStale(sale: AuctionSale, now: Date): boolean {
  if (!sale.updated_at) return true;
  const updatedAt = Date.parse(sale.updated_at);
  if (!Number.isFinite(updatedAt)) return true;
  const dayMs = 24 * 60 * 60 * 1_000;
  return now.getTime() - updatedAt > 14 * dayMs;
}

function runDate(run: AuctionRunRow): Date {
  return new Date(run.finished_at ?? run.started_at ?? run.updated_at ?? run.created_at ?? 0);
}

function runTime(run: AuctionRunRow): number {
  const time = runDate(run).getTime();
  return Number.isFinite(time) ? time : 0;
}

function hoursBetween(date: Date, now: Date): number | null {
  const time = date.getTime();
  if (!Number.isFinite(time) || !Number.isFinite(now.getTime())) return null;
  return Math.round(((now.getTime() - time) / (60 * 60 * 1_000)) * 10) / 10;
}

function statusWeight(status: DataQualityStatus): number {
  if (status === "critical") return 2;
  if (status === "watch") return 1;
  return 0;
}

function pct(count: number, total: number): number {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function averageConfidencePct(sales: AuctionSale[]): number | null {
  const values = sales
    .map((sale) => sale.score_confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 10;
}

function finite(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
