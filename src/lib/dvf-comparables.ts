import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  buildDvfComparableAnalysis,
  type DvfComparableAnalysis,
  type DvfComparableCandidate,
} from "@/lib/dvf-comparable-engine";
import { haversineKm } from "@/lib/geo";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getSaleSurface } from "@/lib/surface";
import { recordFeatureUsageEvent } from "@/lib/usage";

type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];
type DvfTransactionRow = Database["public"]["Tables"]["dvf_transactions"]["Row"];
type DvfComparableRow = Pick<
  DvfTransactionRow,
  | "id"
  | "source_mutation_id"
  | "sale_date"
  | "mutation_nature"
  | "total_price_eur"
  | "built_surface_m2"
  | "land_surface_m2"
  | "price_per_m2"
  | "property_type"
  | "dvf_property_type_code"
  | "address"
  | "city"
  | "postal_code"
  | "parcel_id"
  | "department"
  | "latitude"
  | "longitude"
  | "source"
  | "source_url"
>;

const REFERENCE_SALE_COLUMNS =
  "id,title,city,department,postal_code,address,property_type,starting_price_eur,app_surface_m2,habitable_surface_m2,carrez_surface_m2,land_surface_m2,rooms_count,latitude,longitude";

const DVF_COLUMNS =
  "id,source_mutation_id,sale_date,mutation_nature,total_price_eur,built_surface_m2,land_surface_m2,price_per_m2,property_type,dvf_property_type_code,address,city,postal_code,parcel_id,department,latitude,longitude,source,source_url";

const optionalText = (max = 140) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

export const dvfComparablesQuerySchema = z.object({
  saleId: optionalText().pipe(z.string().uuid()),
  radiusM: z.coerce.number().int().min(300).max(2_000).default(1_000),
  months: z.coerce.number().int().min(6).max(60).default(36),
  limit: z.coerce.number().int().min(3).max(50).default(12),
});

export type DvfComparablesQueryInput = z.input<typeof dvfComparablesQuerySchema>;
export type DvfComparablesQuery = z.output<typeof dvfComparablesQuerySchema>;

export type DvfComparablesResponse = {
  ok: true;
  sale: {
    id: string;
    title: string | null;
    address: string | null;
    city: string | null;
    department: string | null;
    postalCode: string | null;
    propertyType: string | null;
    surfaceM2: number | null;
    startingPriceEur: number | null;
    latitude: number;
    longitude: number;
  };
  scope: {
    radiusM: number;
    months: number;
    limit: number;
    candidateCount: number;
    sourceTable: "dvf_transactions";
  };
  analysis: DvfComparableAnalysis;
};

export async function getDvfComparables({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: DvfComparablesQuery;
  now?: Date;
}): Promise<DvfComparablesResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "property.soldComparables")) {
    throw new Error("Comparables DVF détaillés réservés au plan Analyse.");
  }

  const sale = await getReferenceSale(auth, input.saleId);
  const latitude = finiteNumber(sale.latitude);
  const longitude = finiteNumber(sale.longitude);
  if (latitude == null || longitude == null) {
    throw new Error("Comparables DVF indisponibles : la vente n'est pas géocodée.");
  }

  const surface = getSaleSurface(sale);
  const candidates = await fetchDvfCandidates({
    sale,
    latitude,
    longitude,
    radiusM: input.radiusM,
    months: input.months,
    limit: input.limit,
    now,
  });
  const analysis = buildDvfComparableAnalysis({
    subject: {
      surfaceM2: surface.value,
      landSurfaceM2: sale.land_surface_m2,
      propertyType: sale.property_type,
      startingPriceEur: sale.starting_price_eur,
    },
    candidates,
    options: {
      now,
      maxAgeMonths: input.months,
      maxRadiusM: input.radiusM,
      limit: input.limit,
    },
  });

  await recordFeatureUsageEvent({
    auth,
    eventKey: "dvf.comparables_viewed",
    subjectType: "auction_sale",
    subjectId: sale.id,
    metadata: {
      sample_size: analysis.sampleSize,
      candidate_count: candidates.length,
      radius_m: input.radiusM,
      months: input.months,
      confidence_label: analysis.confidenceLabel,
      comparable_mode: analysis.comparableMode,
    },
  });

  return {
    ok: true,
    sale: {
      id: sale.id,
      title: cleanSaleTitle(sale.title),
      address: sale.address,
      city: sale.city,
      department: sale.department,
      postalCode: sale.postal_code,
      propertyType: sale.property_type,
      surfaceM2: surface.value,
      startingPriceEur: sale.starting_price_eur,
      latitude,
      longitude,
    },
    scope: {
      radiusM: input.radiusM,
      months: input.months,
      limit: input.limit,
      candidateCount: candidates.length,
      sourceTable: "dvf_transactions",
    },
    analysis,
  };
}

async function getReferenceSale(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<AppSaleRow & { id: string }> {
  const { data, error } = await auth.supabase
    .from("v_auction_sales_app")
    .select(REFERENCE_SALE_COLUMNS)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("Vente introuvable ou non accessible.");
  return data as AppSaleRow & { id: string };
}

async function fetchDvfCandidates({
  sale,
  latitude,
  longitude,
  radiusM,
  months,
  limit,
  now,
}: {
  sale: AppSaleRow;
  latitude: number;
  longitude: number;
  radiusM: number;
  months: number;
  limit: number;
  now: Date;
}): Promise<DvfComparableCandidate[]> {
  const bbox = bboxAround(latitude, longitude, radiusM);
  const minSaleDate = addMonths(now, -months);
  let query = supabaseAdmin
    .from("dvf_transactions")
    .select(DVF_COLUMNS)
    .gte("sale_date", minSaleDate)
    .gte("latitude", bbox.latMin)
    .lte("latitude", bbox.latMax)
    .gte("longitude", bbox.lngMin)
    .lte("longitude", bbox.lngMax)
    .not("built_surface_m2", "is", null)
    .gte("built_surface_m2", 9)
    .order("sale_date", { ascending: false })
    .limit(Math.min(2_000, Math.max(limit * 40, 120)));

  if (sale.department) query = query.eq("department", sale.department);

  const { data, error } = await query;
  if (error) {
    throw new Error(`Comparables DVF indisponibles : ${error.message}`);
  }

  return (data ?? [])
    .map((row) => rowToComparableCandidate(row, { latitude, longitude }))
    .filter((candidate) => candidate.distanceM == null || candidate.distanceM <= radiusM);
}

function rowToComparableCandidate(
  row: DvfComparableRow,
  reference: { latitude: number; longitude: number },
): DvfComparableCandidate {
  const rowLat = finiteNumber(row.latitude);
  const rowLng = finiteNumber(row.longitude);
  const distanceM =
    rowLat != null && rowLng != null
      ? Math.round(
          haversineKm(
            { lat: reference.latitude, lng: reference.longitude },
            { lat: rowLat, lng: rowLng },
          ) * 1_000,
        )
      : null;

  return {
    id: row.source_mutation_id || row.id,
    saleDate: row.sale_date,
    totalPriceEur: row.total_price_eur,
    surfaceM2: row.built_surface_m2,
    landSurfaceM2: row.land_surface_m2,
    pricePerM2: row.price_per_m2,
    propertyType: row.property_type ?? row.dvf_property_type_code,
    distanceM,
    address: row.address,
    city: row.city,
    postalCode: row.postal_code,
    parcelId: row.parcel_id,
    source: row.source,
    sourceUrl: row.source_url,
  };
}

function bboxAround(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    latMin: lat - dLat,
    latMax: lat + dLat,
    lngMin: lng - dLng,
    lngMax: lng + dLng,
  };
}

function addMonths(date: Date, months: number): string {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy.toISOString().slice(0, 10);
}

function finiteNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}
