import { z } from "zod";
import { optionalQueryText } from "@/lib/optional-query-text";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { pricePerM2 } from "@/lib/geo";
import { featureIncluded } from "@/lib/plans";
import { readSaleThroughDoor, resolvePlanEntitlements } from "@/lib/entitlements.server";
import { getSaleSurface } from "@/lib/surface";
import type { SelectedRow } from "@/lib/supabase-select";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { roundToTenth as roundedNumber } from "@/lib/rounding";
import { averageRoundedToTenth as averageRounded } from "@/lib/rounding";
import { median } from "@/lib/stats";
import { ForbiddenError } from "@/lib/api-errors";
import { addUtcCalendarMonths } from "@/lib/calendar-months";
import { readComparisonSales } from "@/lib/comparison-scopes";

type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];

const HISTORY_COLUMNS =
  "id,title,city,department,postal_code,address,tribunal,tribunal_code,tribunal_name,property_type,starting_price_eur,adjudication_price_eur,sale_date,status,app_surface_m2,habitable_surface_m2,carrez_surface_m2,land_surface_m2,source_name,source_url,investment_score";

type HistorySaleRow = SelectedRow<AppSaleRow, typeof HISTORY_COLUMNS>;

export const saleHistoryQuerySchema = z
  .object({
    saleId: optionalQueryText().pipe(z.string().guid().optional()),
    department: optionalQueryText(12),
    city: optionalQueryText(140),
    tribunalCode: optionalQueryText(80),
    propertyType: optionalQueryText(80),
    months: z.coerce.number().int().min(1).max(120).default(60),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .refine((value) => value.saleId || value.department || value.city || value.tribunalCode, {
    message: "Indiquez une vente, un département, une ville ou un tribunal.",
  });
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
    throw new ForbiddenError("Historique des ventes passées réservé à l’offre Analyse.");
  }

  const referenceSale = input.saleId
    ? await readSaleThroughDoor<HistorySaleRow>(auth, input.saleId, "plan", HISTORY_COLUMNS)
    : null;
  const fromDate = addUtcCalendarMonths(now, -input.months).toISOString();
  const toDate = now.toISOString();
  const { scope: selectedScope, rows } = await readComparisonSales<HistorySaleRow>({
    auth,
    base: {
      city: input.city ?? referenceSale?.city,
      department: input.department ?? referenceSale?.department,
      tribunalCode: input.tribunalCode ?? referenceSale?.tribunal_code,
      propertyType: input.propertyType ?? referenceSale?.property_type,
    },
    columns: HISTORY_COLUMNS,
    fromDate,
    toDate,
    limit: input.limit,
    referenceSaleId: input.saleId ?? null,
    minRows: 1,
  });

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

  recordFeatureUsageEvent({
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

function rowToHistoryItem(row: HistorySaleRow): SaleHistoryItem {
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

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveNumber(value: unknown): number | null {
  return isPositiveFinite(value) ? value : null;
}

function medianRounded(values: number[]): number | null {
  const value = median(values);
  return value == null ? null : roundedNumber(value);
}
