import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type { MarketPropertySegment } from "@/lib/market-estimation-engine";

type StatisticRow = Database["public"]["Tables"]["dvf_market_statistics"]["Row"];
type StatisticSegment = StatisticRow["segment"];

export type DvfMarketStatisticLocation = {
  code: string;
  name: string;
  departmentCode: string | null;
};

export type DvfMarketStatisticsFallback = {
  geographyLevel: StatisticRow["geography_level"];
  geographyCode: string;
  geographyLabel: string;
  salesCount: number;
  sourceUrl: string;
  sourceUpdatedAt: string | null;
  medianPricePerM2: number;
  p10PricePerM2: number;
  p25PricePerM2: number;
  p75PricePerM2: number;
  p90PricePerM2: number;
  qualityScore: number;
  qualityWarnings: string[];
};

export async function getDvfMarketStatisticsFallback(input: {
  location: DvfMarketStatisticLocation;
  segment: Exclude<MarketPropertySegment, "unsupported">;
  surfaceEstimated: boolean;
  surfaceUncertaintyPct: number | null;
}): Promise<DvfMarketStatisticsFallback | null> {
  const statisticsSegment = segmentForStatistics(input.segment);
  if (!statisticsSegment) return null;

  const [commune, department] = await Promise.all([
    fetchStatistic("commune", input.location.code, statisticsSegment),
    input.location.departmentCode
      ? fetchStatistic("department", input.location.departmentCode, statisticsSegment)
      : Promise.resolve(null),
  ]);
  const epci = commune?.parent_code
    ? await fetchStatistic("epci", commune.parent_code, statisticsSegment)
    : null;
  const selected = selectStatisticScope({ commune, epci, department });
  if (!selected || !isRecentStatistic(selected)) return null;

  return buildDvfMarketStatisticsFallback({
    row: selected,
    sourceSegment: input.segment,
    surfaceEstimated: input.surfaceEstimated,
    surfaceUncertaintyPct: input.surfaceUncertaintyPct,
  });
}

export function selectStatisticScope(input: {
  commune: StatisticRow | null;
  epci: StatisticRow | null;
  department: StatisticRow | null;
}): StatisticRow | null {
  if (usable(input.commune, 5)) return input.commune;
  if (usable(input.epci, 12)) return input.epci;
  if (usable(input.department, 30)) return input.department;
  const usableRows: StatisticRow[] = [];
  for (const row of [input.commune, input.epci, input.department]) {
    if (usable(row, 1)) usableRows.push(row);
  }
  return usableRows.sort((a, b) => b.sales_count - a.sales_count)[0] ?? null;
}

export function buildDvfMarketStatisticsFallback(input: {
  row: StatisticRow;
  sourceSegment: Exclude<MarketPropertySegment, "unsupported">;
  surfaceEstimated: boolean;
  surfaceUncertaintyPct: number | null;
}): DvfMarketStatisticsFallback | null {
  const median = finitePositive(input.row.median_price_per_m2);
  if (!median || input.row.sales_count <= 0) return null;

  const scopeUncertainty =
    input.row.geography_level === "commune"
      ? 0.24
      : input.row.geography_level === "epci"
        ? 0.32
        : 0.4;
  const segmentUncertainty =
    input.sourceSegment === "building" ? 0.12 : input.sourceSegment === "commercial" ? 0.08 : 0;
  const surfaceUncertainty = input.surfaceEstimated
    ? Math.max(0.1, (input.surfaceUncertaintyPct ?? 25) / 100)
    : 0;
  const uncertainty = Math.min(
    0.65,
    Math.max(scopeUncertainty, segmentUncertainty + scopeUncertainty, surfaceUncertainty),
  );
  const innerUncertainty = Math.max(0.12, uncertainty * 0.58);
  const scopeScore =
    input.row.geography_level === "commune" ? 42 : input.row.geography_level === "epci" ? 32 : 22;
  const sampleScore = Math.min(12, Math.round(Math.log10(input.row.sales_count + 1) * 6));
  const qualityScore = Math.max(
    12,
    Math.min(54, scopeScore + sampleScore - (input.sourceSegment === "building" ? 8 : 0)),
  );
  const scopeLabel =
    input.row.geography_level === "commune"
      ? "la commune"
      : input.row.geography_level === "epci"
        ? "l’intercommunalité"
        : "le département";
  const warnings = [
    `estimation indicative de repli fondée sur la médiane de ${input.row.sales_count} ventes à l’échelle de ${scopeLabel}`,
    "absence d’un échantillon suffisant de ventes détaillées autour du bien",
  ];
  if (input.sourceSegment === "building") {
    warnings.unshift(
      "référence résidentielle agrégée utilisée pour l’immeuble, sans ventilation détaillée des lots",
    );
  }
  if (input.surfaceEstimated) {
    warnings.unshift("surface du bien estimée : fourchette de valeur volontairement élargie");
  }

  return {
    geographyLevel: input.row.geography_level,
    geographyCode: input.row.geography_code,
    geographyLabel: input.row.geography_label,
    salesCount: input.row.sales_count,
    sourceUrl: input.row.source_url,
    sourceUpdatedAt: input.row.source_updated_at,
    medianPricePerM2: roundedPrice(median),
    p10PricePerM2: roundedPrice(median * (1 - uncertainty)),
    p25PricePerM2: roundedPrice(median * (1 - innerUncertainty)),
    p75PricePerM2: roundedPrice(median * (1 + innerUncertainty)),
    p90PricePerM2: roundedPrice(median * (1 + uncertainty)),
    qualityScore,
    qualityWarnings: warnings,
  };
}

async function fetchStatistic(
  geographyLevel: StatisticRow["geography_level"],
  geographyCode: string,
  segment: StatisticSegment,
): Promise<StatisticRow | null> {
  const { data, error } = await supabaseAdmin
    .from("dvf_market_statistics")
    .select("*")
    .eq("geography_level", geographyLevel)
    .eq("geography_code", geographyCode)
    .eq("segment", segment)
    .maybeSingle();
  if (error) {
    console.warn(`[dvf-stats] ${geographyLevel} ${geographyCode}: ${error.message}`);
    return null;
  }
  return data;
}

function segmentForStatistics(
  segment: Exclude<MarketPropertySegment, "unsupported">,
): StatisticSegment | null {
  if (segment === "building") return "residential";
  if (segment === "land") return null;
  return segment;
}

function usable(row: StatisticRow | null, minimumSales: number): row is StatisticRow {
  return Boolean(
    row && row.sales_count >= minimumSales && finitePositive(row.median_price_per_m2) != null,
  );
}

function isRecentStatistic(row: StatisticRow): boolean {
  if (!row.source_updated_at) return true;
  const updated = new Date(`${row.source_updated_at}T00:00:00Z`);
  if (Number.isNaN(updated.getTime())) return false;
  const ageMonths =
    (new Date().getUTCFullYear() - updated.getUTCFullYear()) * 12 +
    (new Date().getUTCMonth() - updated.getUTCMonth());
  return ageMonths <= 24;
}

function finitePositive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function roundedPrice(value: number): number {
  return Math.max(10, Math.round(value / 10) * 10);
}
