import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { pricePerM2 } from "@/lib/geo";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSaleSurface } from "@/lib/surface";
import { recordFeatureUsageEvent } from "@/lib/usage";

type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];

const HISTORY_COLUMNS = [
  "id",
  "title",
  "city",
  "department",
  "postal_code",
  "address",
  "tribunal",
  "tribunal_code",
  "tribunal_name",
  "property_type",
  "starting_price_eur",
  "adjudication_price_eur",
  "sale_date",
  "status",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "source_name",
  "source_url",
  "investment_score",
].join(",");

const optionalText = (max = 140) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

export const saleHistoryQuerySchema = z
  .object({
    saleId: optionalText().pipe(z.string().uuid().optional()),
    department: optionalText(12),
    city: optionalText(140),
    tribunalCode: optionalText(80),
    propertyType: optionalText(80),
    months: z.coerce.number().int().min(1).max(120).default(60),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .refine((value) => value.saleId || value.department || value.city || value.tribunalCode, {
    message: "Indiquez une vente, un département, une ville ou un tribunal.",
  });

export type SaleHistoryQueryInput = z.input<typeof saleHistoryQuerySchema>;
export type SaleHistoryQuery = z.output<typeof saleHistoryQuerySchema>;

export type SaleHistoryItem = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  postalCode: string | null;
  address: string | null;
  tribunal: string | null;
  tribunalCode: string | null;
  propertyType: string | null;
  saleDate: string | null;
  status: string | null;
  startingPriceEur: number | null;
  adjudicationPriceEur: number | null;
  surfaceM2: number | null;
  pricePerM2: number | null;
  adjudicationVsStartingPct: number | null;
  investmentScore: number | null;
  sourceName: string | null;
  sourceUrl: string | null;
};

export type SaleHistorySummary = {
  itemCount: number;
  adjudicatedCount: number;
  averageStartingPriceEur: number | null;
  medianStartingPriceEur: number | null;
  averageAdjudicationPriceEur: number | null;
  averagePricePerM2: number | null;
  averageAdjudicationVsStartingPct: number | null;
  earliestSaleDate: string | null;
  latestSaleDate: string | null;
  cities: string[];
};

export type SaleHistoryResponse = {
  items: SaleHistoryItem[];
  summary: SaleHistorySummary;
  scope: {
    label: string;
    months: number;
    limit: number;
    fromDate: string;
    toDate: string;
    city: string | null;
    department: string | null;
    tribunalCode: string | null;
    propertyType: string | null;
  };
};

type HistoryScope = {
  label: string;
  city?: string | null;
  department?: string | null;
  tribunalCode?: string | null;
  propertyType?: string | null;
};

export async function getSaleHistory({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: SaleHistoryQuery;
  now?: Date;
}): Promise<SaleHistoryResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "property.saleHistory")) {
    throw new Error("Historique des ventes passées réservé au plan Analyse.");
  }

  const referenceSale = input.saleId ? await getReferenceSale(auth, input.saleId) : null;
  const scopes = buildHistoryScopes(input, referenceSale);
  const fromDate = monthsAgoIso(now, input.months);
  const toDate = now.toISOString();
  let selectedScope = scopes[0];
  let rows: AppSaleRow[] = [];

  for (const scope of scopes) {
    rows = await queryPastSales({
      auth,
      scope,
      fromDate,
      toDate,
      limit: input.limit,
      excludeSaleId: input.saleId ?? null,
    });
    selectedScope = scope;
    if (rows.length > 0) break;
  }

  const items = rows.map(rowToHistoryItem);
  const response = {
    items,
    summary: buildSaleHistorySummary(items),
    scope: {
      label: selectedScope.label,
      months: input.months,
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
    eventKey: "sale_history.viewed",
    subjectType: input.saleId ? "auction_sale" : "sale_history_scope",
    subjectId: input.saleId ?? null,
    metadata: {
      item_count: items.length,
      months: input.months,
      scope: response.scope.label,
      city: response.scope.city,
      department: response.scope.department,
      tribunal_code: response.scope.tribunalCode,
      property_type: response.scope.propertyType,
    },
  });

  return response;
}

export function buildSaleHistorySummary(items: SaleHistoryItem[]): SaleHistorySummary {
  const startingPrices = items
    .map((item) => item.startingPriceEur)
    .filter((value): value is number => isPositiveFinite(value));
  const adjudicationPrices = items
    .map((item) => item.adjudicationPriceEur)
    .filter((value): value is number => isPositiveFinite(value));
  const pricePerM2Values = items
    .map((item) => item.pricePerM2)
    .filter((value): value is number => isPositiveFinite(value));
  const adjudicationDeltas = items
    .map((item) => item.adjudicationVsStartingPct)
    .filter((value): value is number => Number.isFinite(value));
  const saleDates = items
    .map((item) => item.saleDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  const cities = Array.from(
    new Set(items.map((item) => item.city).filter((value): value is string => Boolean(value))),
  ).slice(0, 8);

  return {
    itemCount: items.length,
    adjudicatedCount: adjudicationPrices.length,
    averageStartingPriceEur: averageRounded(startingPrices),
    medianStartingPriceEur: medianRounded(startingPrices),
    averageAdjudicationPriceEur: averageRounded(adjudicationPrices),
    averagePricePerM2: averageRounded(pricePerM2Values),
    averageAdjudicationVsStartingPct: averageRounded(adjudicationDeltas),
    earliestSaleDate: saleDates[0] ?? null,
    latestSaleDate: saleDates.at(-1) ?? null,
    cities,
  };
}

async function getReferenceSale(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<AppSaleRow | null> {
  const { data, error } = await auth.supabase
    .from("v_auction_sales_app")
    .select(HISTORY_COLUMNS)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as unknown as AppSaleRow | null;
}

function buildHistoryScopes(input: SaleHistoryQuery, referenceSale: AppSaleRow | null) {
  const base = {
    city: input.city ?? referenceSale?.city ?? null,
    department: input.department ?? referenceSale?.department ?? null,
    tribunalCode: input.tribunalCode ?? referenceSale?.tribunal_code ?? null,
    propertyType: input.propertyType ?? referenceSale?.property_type ?? null,
  };
  const scopes: HistoryScope[] = [];

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
      label: "Même tribunal",
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
      propertyType: base.propertyType,
    });
  }

  return uniqueScopes(scopes.length ? scopes : [{ label: "Périmètre demandé", ...base }]);
}

async function queryPastSales({
  auth,
  scope,
  fromDate,
  toDate,
  limit,
  excludeSaleId,
}: {
  auth: SupabaseAuthContext;
  scope: HistoryScope;
  fromDate: string;
  toDate: string;
  limit: number;
  excludeSaleId: string | null;
}): Promise<AppSaleRow[]> {
  let query = auth.supabase
    .from("v_auction_sales_app")
    .select(HISTORY_COLUMNS)
    .not("id", "is", null)
    .not("sale_date", "is", null)
    .gte("sale_date", fromDate)
    .lte("sale_date", toDate)
    .order("sale_date", { ascending: false })
    .limit(limit);

  if (excludeSaleId) query = query.neq("id", excludeSaleId);
  if (scope.city) query = query.eq("city", scope.city);
  if (scope.department) query = query.eq("department", scope.department);
  if (scope.tribunalCode) query = query.eq("tribunal_code", scope.tribunalCode);
  if (scope.propertyType) query = query.eq("property_type", scope.propertyType);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AppSaleRow[];
}

function rowToHistoryItem(row: AppSaleRow): SaleHistoryItem {
  const surface = getSaleSurface(row).value;
  const startingPrice = positiveNumber(row.starting_price_eur);
  const adjudicationPrice = positiveNumber(row.adjudication_price_eur);

  return {
    id: row.id ?? "",
    title: row.title,
    city: row.city,
    department: row.department,
    postalCode: row.postal_code,
    address: row.address,
    tribunal: row.tribunal_name ?? row.tribunal,
    tribunalCode: row.tribunal_code,
    propertyType: row.property_type,
    saleDate: row.sale_date,
    status: row.status,
    startingPriceEur: startingPrice,
    adjudicationPriceEur: adjudicationPrice,
    surfaceM2: surface,
    pricePerM2: roundedNumber(pricePerM2(adjudicationPrice ?? startingPrice, surface)),
    adjudicationVsStartingPct:
      startingPrice && adjudicationPrice
        ? roundedNumber(((adjudicationPrice - startingPrice) / startingPrice) * 100)
        : null,
    investmentScore: roundedNumber(row.investment_score),
    sourceName: row.source_name,
    sourceUrl: row.source_url,
  };
}

function uniqueScopes(scopes: HistoryScope[]): HistoryScope[] {
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

function monthsAgoIso(now: Date, months: number): string {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveNumber(value: unknown): number | null {
  return isPositiveFinite(value) ? value : null;
}

function roundedNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function averageRounded(values: number[]): number | null {
  if (!values.length) return null;
  return roundedNumber(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function medianRounded(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return roundedNumber(sorted[midpoint]);
  return roundedNumber((sorted[midpoint - 1] + sorted[midpoint]) / 2);
}
