import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { pricePerM2 } from "@/lib/geo";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSaleSurface } from "@/lib/surface";
import { recordFeatureUsageEvent } from "@/lib/usage";

type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];

const MARKET_COLUMNS = [
  "id",
  "title",
  "city",
  "department",
  "tribunal_code",
  "tribunal_name",
  "property_type",
  "starting_price_eur",
  "adjudication_price_eur",
  "sale_date",
  "created_at",
  "status",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "investment_score",
].join(",");

const optionalText = (max = 140) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

export const marketAnalyticsQuerySchema = z
  .object({
    saleId: optionalText().pipe(z.string().uuid().optional()),
    department: optionalText(12),
    city: optionalText(140),
    tribunalCode: optionalText(80),
    propertyType: optionalText(80),
    months: z.coerce.number().int().min(3).max(120).default(36),
    futureMonths: z.coerce.number().int().min(0).max(24).default(6),
    limit: z.coerce.number().int().min(20).max(1000).default(500),
  })
  .refine((value) => value.saleId || value.department || value.city || value.tribunalCode, {
    message: "Indiquez une vente, un département, une ville ou un tribunal.",
  });

export type MarketAnalyticsQueryInput = z.input<typeof marketAnalyticsQuerySchema>;
export type MarketAnalyticsQuery = z.output<typeof marketAnalyticsQuerySchema>;

export type MarketAnalyticsItem = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  tribunalCode: string | null;
  tribunalName: string | null;
  propertyType: string | null;
  status: string | null;
  saleDate: string | null;
  createdAt: string | null;
  startingPriceEur: number | null;
  adjudicationPriceEur: number | null;
  surfaceM2: number | null;
  pricePerM2: number | null;
  investmentScore: number | null;
  daysToSale: number | null;
  isUpcoming: boolean;
};

export type MarketAnalyticsSummary = {
  sampleSize: number;
  upcomingCount: number;
  pastCount: number;
  medianStartingPriceEur: number | null;
  p25StartingPriceEur: number | null;
  p75StartingPriceEur: number | null;
  medianPricePerM2: number | null;
  averageInvestmentScore: number | null;
  averageDaysToSale: number | null;
};

export type MarketAnalyticsBucket = {
  label: string;
  min: number | null;
  max: number | null;
  count: number;
  sharePct: number;
};

export type MarketAnalyticsPeriod = {
  period: string;
  count: number;
  medianStartingPriceEur: number | null;
  medianPricePerM2: number | null;
  averageDaysToSale: number | null;
};

export type MarketAnalyticsSegment = {
  label: string;
  segmentKind: "city" | "property_type";
  count: number;
  medianStartingPriceEur: number | null;
  medianPricePerM2: number | null;
  averageInvestmentScore: number | null;
};

export type MarketAnalyticsRotation = {
  label: string;
  liquidityLabel: string;
  upcomingCount: number;
  pastCount: number;
  monthlyVolume: number | null;
  pipelineRatioPct: number | null;
  averageDaysToSale: number | null;
  interpretation: string;
};

export type MarketAnalyticsTrend = {
  metric: "price_per_m2" | "volume" | "sale_delay";
  label: string;
  direction: "up" | "down" | "stable" | "missing";
  periodFrom: string | null;
  periodTo: string | null;
  startValue: number | null;
  endValue: number | null;
  changePct: number | null;
  interpretation: string;
};

export type MarketAnalyticsSnapshot = {
  summary: MarketAnalyticsSummary;
  priceDistribution: MarketAnalyticsBucket[];
  volumeEvolution: MarketAnalyticsPeriod[];
  saleDelayEvolution: MarketAnalyticsPeriod[];
  rotationRate: MarketAnalyticsRotation;
  marketTrends: MarketAnalyticsTrend[];
  comparisonSegments: MarketAnalyticsSegment[];
  communeComparison: MarketAnalyticsSegment[];
};

export type MarketAnalyticsResponse = MarketAnalyticsSnapshot & {
  items: MarketAnalyticsItem[];
  scope: {
    label: string;
    months: number;
    futureMonths: number;
    limit: number;
    fromDate: string;
    toDate: string;
    city: string | null;
    department: string | null;
    tribunalCode: string | null;
    propertyType: string | null;
  };
};

type AnalyticsScope = {
  label: string;
  city?: string | null;
  department?: string | null;
  tribunalCode?: string | null;
  propertyType?: string | null;
};

export async function getMarketAnalytics({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: MarketAnalyticsQuery;
  now?: Date;
}): Promise<MarketAnalyticsResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "market.priceDistribution")) {
    throw new Error("Analyse de marché avancée réservée au plan Analyse.");
  }

  const referenceSale = input.saleId ? await getReferenceSale(auth, input.saleId) : null;
  const scopes = buildAnalyticsScopes(input, referenceSale);
  const fromDate = addMonthsIso(now, -input.months);
  const toDate = addMonthsIso(now, input.futureMonths);
  let selectedScope = scopes[0];
  let rows: AppSaleRow[] = [];

  for (const scope of scopes) {
    rows = await queryMarketSales({
      auth,
      scope,
      fromDate,
      toDate,
      limit: input.limit,
    });
    selectedScope = scope;
    if (rows.length >= 5) break;
  }

  const items = rows.map((row) => rowToMarketItem(row, now));
  const snapshot = buildMarketAnalyticsSnapshot(items);
  const response = {
    ...snapshot,
    items: items.slice(0, 30),
    scope: {
      label: selectedScope.label,
      months: input.months,
      futureMonths: input.futureMonths,
      limit: input.limit,
      fromDate,
      toDate,
      city: selectedScope.city ?? null,
      department: selectedScope.department ?? null,
      tribunalCode: selectedScope.tribunalCode ?? null,
      propertyType: selectedScope.propertyType ?? null,
    },
  };

  await recordFeatureUsageEvent({
    auth,
    eventKey: "market.analytics_viewed",
    subjectType: input.saleId ? "auction_sale" : "market_scope",
    subjectId: input.saleId ?? null,
    metadata: {
      sample_size: snapshot.summary.sampleSize,
      scope: response.scope.label,
      months: input.months,
      future_months: input.futureMonths,
      city: response.scope.city,
      department: response.scope.department,
      tribunal_code: response.scope.tribunalCode,
      property_type: response.scope.propertyType,
    },
  });

  return response;
}

export function buildMarketAnalyticsSnapshot(
  items: MarketAnalyticsItem[],
): MarketAnalyticsSnapshot {
  const prices = items
    .map((item) => item.startingPriceEur)
    .filter((value): value is number => isPositiveFinite(value));
  const pricePerM2Values = items
    .map((item) => item.pricePerM2)
    .filter((value): value is number => isPositiveFinite(value));
  const scores = items
    .map((item) => item.investmentScore)
    .filter((value): value is number => isPositiveFinite(value));
  const daysToSale = items
    .map((item) => item.daysToSale)
    .filter((value): value is number => isPositiveFinite(value));

  const volumeEvolution = buildPeriodEvolution(items);
  const saleDelayEvolution = buildPeriodEvolution(
    items.filter((item) => item.daysToSale != null),
  ).filter((period) => period.averageDaysToSale != null);

  return {
    summary: {
      sampleSize: items.length,
      upcomingCount: items.filter((item) => item.isUpcoming).length,
      pastCount: items.filter((item) => !item.isUpcoming).length,
      medianStartingPriceEur: percentileRounded(prices, 0.5),
      p25StartingPriceEur: percentileRounded(prices, 0.25),
      p75StartingPriceEur: percentileRounded(prices, 0.75),
      medianPricePerM2: percentileRounded(pricePerM2Values, 0.5),
      averageInvestmentScore: averageRounded(scores),
      averageDaysToSale: averageRounded(daysToSale),
    },
    priceDistribution: buildPriceDistribution(prices),
    volumeEvolution,
    saleDelayEvolution,
    rotationRate: buildRotationRate({ items, daysToSale }),
    marketTrends: buildMarketTrends({ volumeEvolution, saleDelayEvolution }),
    comparisonSegments: buildComparisonSegments(items),
    communeComparison: buildCommuneComparison(items),
  };
}

async function getReferenceSale(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<AppSaleRow | null> {
  const { data, error } = await auth.supabase
    .from("v_auction_sales_app")
    .select(MARKET_COLUMNS)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as unknown as AppSaleRow | null;
}

function buildAnalyticsScopes(input: MarketAnalyticsQuery, referenceSale: AppSaleRow | null) {
  const base = {
    city: input.city ?? referenceSale?.city ?? null,
    department: input.department ?? referenceSale?.department ?? null,
    tribunalCode: input.tribunalCode ?? referenceSale?.tribunal_code ?? null,
    propertyType: input.propertyType ?? referenceSale?.property_type ?? null,
  };
  const scopes: AnalyticsScope[] = [];

  if (base.city && base.department) {
    scopes.push({
      label: "Même ville et même type de bien",
      city: base.city,
      department: base.department,
      propertyType: base.propertyType,
    });
  }
  if (base.tribunalCode) {
    scopes.push({
      label: "Même tribunal et même type de bien",
      tribunalCode: base.tribunalCode,
      propertyType: base.propertyType,
    });
  }
  if (base.department) {
    scopes.push({
      label: "Même département et même type de bien",
      department: base.department,
      propertyType: base.propertyType,
    });
    scopes.push({
      label: "Même département",
      department: base.department,
    });
  }
  if (base.city) {
    scopes.push({
      label: "Même ville",
      city: base.city,
    });
  }

  return uniqueScopes(scopes.length ? scopes : [{ label: "Périmètre demandé", ...base }]);
}

async function queryMarketSales({
  auth,
  scope,
  fromDate,
  toDate,
  limit,
}: {
  auth: SupabaseAuthContext;
  scope: AnalyticsScope;
  fromDate: string;
  toDate: string;
  limit: number;
}): Promise<AppSaleRow[]> {
  let query = auth.supabase
    .from("v_auction_sales_app")
    .select(MARKET_COLUMNS)
    .not("id", "is", null)
    .not("sale_date", "is", null)
    .gte("sale_date", fromDate)
    .lte("sale_date", toDate)
    .order("sale_date", { ascending: false })
    .limit(limit);

  if (scope.city) query = query.eq("city", scope.city);
  if (scope.department) query = query.eq("department", scope.department);
  if (scope.tribunalCode) query = query.eq("tribunal_code", scope.tribunalCode);
  if (scope.propertyType) query = query.eq("property_type", scope.propertyType);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AppSaleRow[];
}

function rowToMarketItem(row: AppSaleRow, now: Date): MarketAnalyticsItem {
  const surface = getSaleSurface(row).value;
  const startingPrice = positiveNumber(row.starting_price_eur);
  const adjudicationPrice = positiveNumber(row.adjudication_price_eur);
  const saleDate = parseDate(row.sale_date);
  const createdAt = parseDate(row.created_at);

  return {
    id: row.id ?? "",
    title: row.title,
    city: row.city,
    department: row.department,
    tribunalCode: row.tribunal_code,
    tribunalName: row.tribunal_name,
    propertyType: row.property_type,
    status: row.status,
    saleDate: row.sale_date,
    createdAt: row.created_at,
    startingPriceEur: startingPrice,
    adjudicationPriceEur: adjudicationPrice,
    surfaceM2: surface,
    pricePerM2: roundedNumber(pricePerM2(adjudicationPrice ?? startingPrice, surface)),
    investmentScore: roundedNumber(row.investment_score),
    daysToSale: saleDate && createdAt ? positiveRounded(daysBetween(createdAt, saleDate)) : null,
    isUpcoming: saleDate ? saleDate.getTime() > now.getTime() : false,
  };
}

function buildPriceDistribution(prices: number[]): MarketAnalyticsBucket[] {
  const buckets = [
    { label: "< 50 k€", min: null, max: 50_000 },
    { label: "50-100 k€", min: 50_000, max: 100_000 },
    { label: "100-200 k€", min: 100_000, max: 200_000 },
    { label: "200-400 k€", min: 200_000, max: 400_000 },
    { label: "> 400 k€", min: 400_000, max: null },
  ];
  const total = prices.length;

  return buckets.map((bucket) => {
    const count = prices.filter((price) => {
      const aboveMin = bucket.min == null || price >= bucket.min;
      const belowMax = bucket.max == null || price < bucket.max;
      return aboveMin && belowMax;
    }).length;

    return {
      ...bucket,
      count,
      sharePct: total ? (roundedNumber((count / total) * 100) ?? 0) : 0,
    };
  });
}

function buildPeriodEvolution(items: MarketAnalyticsItem[]): MarketAnalyticsPeriod[] {
  const grouped = new Map<string, MarketAnalyticsItem[]>();
  for (const item of items) {
    if (!item.saleDate) continue;
    const period = item.saleDate.slice(0, 7);
    grouped.set(period, [...(grouped.get(period) ?? []), item]);
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, periodItems]) => ({
      period,
      count: periodItems.length,
      medianStartingPriceEur: percentileRounded(
        periodItems
          .map((item) => item.startingPriceEur)
          .filter((value): value is number => isPositiveFinite(value)),
        0.5,
      ),
      medianPricePerM2: percentileRounded(
        periodItems
          .map((item) => item.pricePerM2)
          .filter((value): value is number => isPositiveFinite(value)),
        0.5,
      ),
      averageDaysToSale: averageRounded(
        periodItems
          .map((item) => item.daysToSale)
          .filter((value): value is number => isPositiveFinite(value)),
      ),
    }));
}

function buildComparisonSegments(items: MarketAnalyticsItem[]): MarketAnalyticsSegment[] {
  const segmentKind: MarketAnalyticsSegment["segmentKind"] =
    new Set(items.map((item) => item.city).filter(Boolean)).size > 1 ? "city" : "property_type";
  const grouped = new Map<string, MarketAnalyticsItem[]>();

  for (const item of items) {
    const label =
      segmentKind === "city"
        ? (item.city ?? "Ville non renseignée")
        : (item.propertyType ?? "Type non renseigné");
    grouped.set(label, [...(grouped.get(label) ?? []), item]);
  }

  return Array.from(grouped.entries())
    .map(([label, segmentItems]) => ({
      label,
      segmentKind,
      count: segmentItems.length,
      medianStartingPriceEur: percentileRounded(
        segmentItems
          .map((item) => item.startingPriceEur)
          .filter((value): value is number => isPositiveFinite(value)),
        0.5,
      ),
      medianPricePerM2: percentileRounded(
        segmentItems
          .map((item) => item.pricePerM2)
          .filter((value): value is number => isPositiveFinite(value)),
        0.5,
      ),
      averageInvestmentScore: averageRounded(
        segmentItems
          .map((item) => item.investmentScore)
          .filter((value): value is number => isPositiveFinite(value)),
      ),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function buildCommuneComparison(items: MarketAnalyticsItem[]): MarketAnalyticsSegment[] {
  return buildSegments(items, "city").slice(0, 8);
}

function buildSegments(
  items: MarketAnalyticsItem[],
  segmentKind: MarketAnalyticsSegment["segmentKind"],
): MarketAnalyticsSegment[] {
  const grouped = new Map<string, MarketAnalyticsItem[]>();

  for (const item of items) {
    const label =
      segmentKind === "city"
        ? (item.city ?? "Ville non renseignée")
        : (item.propertyType ?? "Type non renseigné");
    grouped.set(label, [...(grouped.get(label) ?? []), item]);
  }

  return Array.from(grouped.entries())
    .map(([label, segmentItems]) => ({
      label,
      segmentKind,
      count: segmentItems.length,
      medianStartingPriceEur: percentileRounded(
        segmentItems
          .map((item) => item.startingPriceEur)
          .filter((value): value is number => isPositiveFinite(value)),
        0.5,
      ),
      medianPricePerM2: percentileRounded(
        segmentItems
          .map((item) => item.pricePerM2)
          .filter((value): value is number => isPositiveFinite(value)),
        0.5,
      ),
      averageInvestmentScore: averageRounded(
        segmentItems
          .map((item) => item.investmentScore)
          .filter((value): value is number => isPositiveFinite(value)),
      ),
    }))
    .sort((a, b) => b.count - a.count);
}

function buildRotationRate({
  items,
  daysToSale,
}: {
  items: MarketAnalyticsItem[];
  daysToSale: number[];
}): MarketAnalyticsRotation {
  const upcomingCount = items.filter((item) => item.isUpcoming).length;
  const pastCount = items.filter((item) => !item.isUpcoming).length;
  const monthlyVolume = roundedNumber(items.length / Math.max(1, distinctMonths(items).length));
  const pipelineRatioPct = pastCount > 0 ? roundedNumber((upcomingCount / pastCount) * 100) : null;
  const averageDaysToSale = averageRounded(daysToSale);
  const liquidityLabel = marketLiquidityLabel({ monthlyVolume, averageDaysToSale, pastCount });
  const label = rotationLabel({ upcomingCount, pastCount, pipelineRatioPct });

  return {
    label,
    liquidityLabel,
    upcomingCount,
    pastCount,
    monthlyVolume,
    pipelineRatioPct,
    averageDaysToSale,
    interpretation: rotationInterpretation({ liquidityLabel, label }),
  };
}

function buildMarketTrends({
  volumeEvolution,
  saleDelayEvolution,
}: {
  volumeEvolution: MarketAnalyticsPeriod[];
  saleDelayEvolution: MarketAnalyticsPeriod[];
}): MarketAnalyticsTrend[] {
  return [
    buildTrend({
      metric: "price_per_m2",
      label: "Évolution des prix/m²",
      periods: volumeEvolution.filter((period) => period.medianPricePerM2 != null),
      valueForPeriod: (period) => period.medianPricePerM2,
      interpretationForTrend: priceTrendInterpretation,
    }),
    buildTrend({
      metric: "volume",
      label: "Évolution des volumes",
      periods: volumeEvolution,
      valueForPeriod: (period) => period.count,
      interpretationForTrend: volumeTrendInterpretation,
    }),
    buildTrend({
      metric: "sale_delay",
      label: "Évolution des délais",
      periods: saleDelayEvolution.filter((period) => period.averageDaysToSale != null),
      valueForPeriod: (period) => period.averageDaysToSale,
      interpretationForTrend: delayTrendInterpretation,
    }),
  ];
}

function buildTrend({
  metric,
  label,
  periods,
  valueForPeriod,
  interpretationForTrend,
}: {
  metric: MarketAnalyticsTrend["metric"];
  label: string;
  periods: MarketAnalyticsPeriod[];
  valueForPeriod: (period: MarketAnalyticsPeriod) => number | null;
  interpretationForTrend: (trend: Pick<MarketAnalyticsTrend, "direction" | "changePct">) => string;
}): MarketAnalyticsTrend {
  if (periods.length < 2) {
    return {
      metric,
      label,
      direction: "missing",
      periodFrom: periods[0]?.period ?? null,
      periodTo: periods.at(-1)?.period ?? null,
      startValue: null,
      endValue: null,
      changePct: null,
      interpretation: `${label} à enrichir : pas assez de périodes comparables.`,
    };
  }

  const first = periods[0];
  const last = periods[periods.length - 1];
  const startValue = valueForPeriod(first);
  const endValue = valueForPeriod(last);
  const changePct =
    startValue != null && startValue > 0 && endValue != null
      ? roundedNumber(((endValue - startValue) / startValue) * 100)
      : null;
  const direction = trendDirection(changePct);

  return {
    metric,
    label,
    direction,
    periodFrom: first.period,
    periodTo: last.period,
    startValue: roundedNumber(startValue),
    endValue: roundedNumber(endValue),
    changePct,
    interpretation: interpretationForTrend({ direction, changePct }),
  };
}

function trendDirection(changePct: number | null): MarketAnalyticsTrend["direction"] {
  if (changePct == null) return "missing";
  if (Math.abs(changePct) < 5) return "stable";
  return changePct > 0 ? "up" : "down";
}

function priceTrendInterpretation({
  direction,
  changePct,
}: Pick<MarketAnalyticsTrend, "direction" | "changePct">): string {
  if (direction === "up") {
    return `Prix/m² en hausse (${formatSignedPct(changePct)}) : vérifier que la mise à prix reste décotée face au marché récent.`;
  }
  if (direction === "down") {
    return `Prix/m² en baisse (${formatSignedPct(changePct)}) : renforcer la marge de sécurité sur la valeur de sortie.`;
  }
  if (direction === "stable") {
    return `Prix/m² stable (${formatSignedPct(changePct)}) : utiliser la médiane locale comme repère principal.`;
  }
  return "Prix/m² à enrichir : pas assez de périodes comparables.";
}

function volumeTrendInterpretation({
  direction,
  changePct,
}: Pick<MarketAnalyticsTrend, "direction" | "changePct">): string {
  if (direction === "up") {
    return `Volumes en hausse (${formatSignedPct(changePct)}) : surveiller les dossiers concurrents et la profondeur d'enchères.`;
  }
  if (direction === "down") {
    return `Volumes en baisse (${formatSignedPct(changePct)}) : anticiper une liquidité plus faible à la revente.`;
  }
  if (direction === "stable") {
    return `Volumes stables (${formatSignedPct(changePct)}) : comparer les opportunités dossier par dossier.`;
  }
  return "Volumes à enrichir : pas assez de périodes comparables.";
}

function delayTrendInterpretation({
  direction,
  changePct,
}: Pick<MarketAnalyticsTrend, "direction" | "changePct">): string {
  if (direction === "up") {
    return `Délais en hausse (${formatSignedPct(changePct)}) : intégrer plus de temps avant audience dans le suivi.`;
  }
  if (direction === "down") {
    return `Délais en baisse (${formatSignedPct(changePct)}) : préparer financement, avocat et visite plus tôt.`;
  }
  if (direction === "stable") {
    return `Délais stables (${formatSignedPct(changePct)}) : caler la checklist sur le délai moyen observé.`;
  }
  return "Délais à enrichir : dates de création ou d'audience insuffisantes.";
}

function formatSignedPct(value: number | null): string {
  if (value == null) return "n/a";
  return `${value > 0 ? "+" : ""}${value} %`;
}

function distinctMonths(items: MarketAnalyticsItem[]): string[] {
  return [
    ...new Set(
      items
        .map((item) => item.saleDate?.slice(0, 7))
        .filter((period): period is string => Boolean(period)),
    ),
  ];
}

function marketLiquidityLabel({
  monthlyVolume,
  averageDaysToSale,
  pastCount,
}: {
  monthlyVolume: number | null;
  averageDaysToSale: number | null;
  pastCount: number;
}): string {
  if (!pastCount) return "Historique insuffisant";
  if ((monthlyVolume ?? 0) >= 6 && (averageDaysToSale == null || averageDaysToSale <= 45)) {
    return "Marché judiciaire actif";
  }
  if ((monthlyVolume ?? 0) >= 2 || (averageDaysToSale != null && averageDaysToSale <= 75)) {
    return "Marché modérément liquide";
  }
  return "Marché peu liquide";
}

function rotationLabel({
  upcomingCount,
  pastCount,
  pipelineRatioPct,
}: {
  upcomingCount: number;
  pastCount: number;
  pipelineRatioPct: number | null;
}): string {
  if (!pastCount && upcomingCount) return "Pipeline à venir sans historique suffisant";
  if (pipelineRatioPct == null) return "Rotation à qualifier";
  if (pipelineRatioPct >= 80) return "Pipeline très fourni";
  if (pipelineRatioPct >= 35) return "Pipeline équilibré";
  return "Pipeline limité";
}

function rotationInterpretation({
  liquidityLabel,
  label,
}: {
  liquidityLabel: string;
  label: string;
}): string {
  if (liquidityLabel === "Marché judiciaire actif") {
    return `${label} : comparer rapidement les dossiers proches et surveiller le niveau d'enchère.`;
  }
  if (liquidityLabel === "Marché modérément liquide") {
    return `${label} : garder une marge de sécurité sur délai de revente et prix de sortie.`;
  }
  if (liquidityLabel === "Marché peu liquide") {
    return `${label} : renforcer la décote exigée et vérifier la profondeur de demande locale.`;
  }
  return `${label} : l'échantillon ne suffit pas encore à qualifier la rotation du marché.`;
}

function uniqueScopes(scopes: AnalyticsScope[]): AnalyticsScope[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = JSON.stringify([
      scope.city ?? null,
      scope.department ?? null,
      scope.tribunalCode ?? null,
      scope.propertyType ?? null,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(scope.city || scope.department || scope.tribunalCode || scope.propertyType);
  });
}

function addMonthsIso(now: Date, months: number): string {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString();
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveNumber(value: unknown): number | null {
  return isPositiveFinite(value) ? value : null;
}

function positiveRounded(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? roundedNumber(value) : null;
}

function roundedNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function averageRounded(values: number[]): number | null {
  if (!values.length) return null;
  return roundedNumber(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentileRounded(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return roundedNumber(sorted[lower]);
  const ratio = index - lower;
  return roundedNumber(sorted[lower] * (1 - ratio) + sorted[upper] * ratio);
}
