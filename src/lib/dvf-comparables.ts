import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  buildDvfComparableAnalysis,
  DVF_PUBLIC_SOURCE_URL,
  type DvfComparableAnalysis,
  type DvfComparableCandidate,
} from "@/lib/dvf-comparable-engine";
import { resolveMarketPropertySegment } from "@/lib/market-estimation-engine";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getSaleSurface } from "@/lib/surface";
import { recordFeatureUsageEvent } from "@/lib/usage";

type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];
type DvfComparableRow =
  Database["public"]["Functions"]["search_dvf_market_comparables"]["Returns"][number];
type DvfDisplayRow = Pick<
  Database["public"]["Tables"]["dvf_transactions"]["Row"],
  "id" | "address" | "city" | "postal_code" | "source"
>;

/** Lignes lues dans la base pour un bien : le même plafond que le moteur d'estimation de marché. */
const DVF_SAMPLE_LIMIT = 2_500;

const REFERENCE_SALE_COLUMNS =
  "id,title,city,department,postal_code,address,property_type,starting_price_eur,app_surface_m2,habitable_surface_m2,carrez_surface_m2,land_surface_m2,rooms_count,latitude,longitude";

/** Colonnes d'affichage que la recherche par segment et distance ne renvoie pas. */
const DVF_DISPLAY_COLUMNS = "id,address,city,postal_code,source";

const optionalText = (max = 140) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

export const dvfComparablesQuerySchema = z.object({
  saleId: optionalText().pipe(z.string().guid()),
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
    throw new Error("Comparables DVF détaillés réservés à l’offre Analyse.");
  }

  const sale = await getReferenceSale(auth, input.saleId);
  const latitude = finiteNumber(sale.latitude);
  const longitude = finiteNumber(sale.longitude);
  if (latitude == null || longitude == null) {
    throw new Error("Comparables DVF indisponibles : la vente n'est pas géocodée.");
  }

  const surface = getSaleSurface(sale);
  // Même découpage par segment (appartement, maison, immeuble, local, terrain) et même distance
  // exacte que le moteur d'estimation de marché : un appartement n'est plus comparé à des maisons.
  const segment = resolveMarketPropertySegment({ propertyType: sale.property_type });
  const { candidates, rowIdByCandidateId } = await fetchDvfCandidates({
    segment,
    latitude,
    longitude,
    radiusM: input.radiusM,
    months: input.months,
    now,
  });
  const subjectSurfaceM2 =
    segment === "land" ? (finiteNumber(sale.land_surface_m2) ?? surface.value) : surface.value;
  const rawAnalysis = buildDvfComparableAnalysis({
    subject: {
      surfaceM2: subjectSurfaceM2,
      landSurfaceM2: sale.land_surface_m2,
      propertyType: sale.property_type,
      startingPriceEur: sale.starting_price_eur,
    },
    candidates,
    options: {
      now,
      maxAgeMonths: input.months,
      maxRadiusM: input.radiusM,
      // N'affecte que la liste affichée : la médiane et les quartiles portent sur tout l'échantillon.
      limit: input.limit,
    },
  });
  const analysis = await withDisplayDetails(rawAnalysis, rowIdByCandidateId);

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
  segment,
  latitude,
  longitude,
  radiusM,
  months,
  now,
}: {
  segment: ReturnType<typeof resolveMarketPropertySegment>;
  latitude: number;
  longitude: number;
  radiusM: number;
  months: number;
  now: Date;
}): Promise<{ candidates: DvfComparableCandidate[]; rowIdByCandidateId: Map<string, string> }> {
  // Un type de bien que DVF ne sait pas ranger dans un segment n'a pas de comparables fiables.
  if (segment === "unsupported") return { candidates: [], rowIdByCandidateId: new Map() };
  const { data, error } = await supabaseAdmin.rpc("search_dvf_market_comparables", {
    p_latitude: latitude,
    p_longitude: longitude,
    p_radius_m: radiusM,
    p_minimum_date: addMonths(now, -months),
    p_segment: segment,
    p_limit: DVF_SAMPLE_LIMIT,
  });
  if (error) {
    throw new Error(`Comparables DVF indisponibles : ${error.message}`);
  }

  const rowIdByCandidateId = new Map<string, string>();
  const candidates = (data ?? [])
    .filter((row) => row.mutation_nature === "Vente")
    .map((row) => {
      const candidate = rowToComparableCandidate(row, segment);
      rowIdByCandidateId.set(candidate.id, row.id);
      return candidate;
    })
    .filter((candidate) => candidate.distanceM == null || candidate.distanceM <= radiusM);
  return { candidates, rowIdByCandidateId };
}

function rowToComparableCandidate(
  row: DvfComparableRow,
  segment: Exclude<ReturnType<typeof resolveMarketPropertySegment>, "unsupported">,
): DvfComparableCandidate {
  return {
    id: row.source_mutation_id || row.id,
    saleDate: row.sale_date,
    totalPriceEur: row.total_price_eur,
    // Un terrain se compare à la surface du terrain, les autres biens à la surface bâtie.
    surfaceM2: segment === "land" ? row.land_surface_m2 : row.built_surface_m2,
    landSurfaceM2: row.land_surface_m2,
    pricePerM2: row.price_per_m2,
    propertyType: row.property_type ?? row.dvf_property_type_code,
    distanceM: finiteNumber(row.distance_m),
    parcelId: row.parcel_id,
    sourceUrl: DVF_PUBLIC_SOURCE_URL,
  };
}

/**
 * Adresse, commune, code postal et source ne servent qu'aux lignes affichées : la recherche par
 * segment et distance ne les renvoie pas, on les lit pour les seules lignes de la liste.
 */
async function withDisplayDetails(
  analysis: DvfComparableAnalysis,
  rowIdByCandidateId: Map<string, string>,
): Promise<DvfComparableAnalysis> {
  const ids = [
    ...new Set(
      analysis.comparables
        .map((comparable) => rowIdByCandidateId.get(comparable.id))
        .filter((id): id is string => id != null),
    ),
  ];
  if (!ids.length) return analysis;
  const { data, error } = await supabaseAdmin
    .from("dvf_transactions")
    .select(DVF_DISPLAY_COLUMNS)
    .in("id", ids);
  // Les détails d'affichage manquants n'empêchent pas l'analyse : les statistiques sont déjà calculées.
  if (error || !data) return analysis;
  const detailsByRowId = new Map((data as DvfDisplayRow[]).map((row) => [row.id, row]));
  return {
    ...analysis,
    comparables: analysis.comparables.map((comparable) => {
      const details = detailsByRowId.get(rowIdByCandidateId.get(comparable.id) ?? "");
      return details
        ? {
            ...comparable,
            address: details.address,
            city: details.city,
            postalCode: details.postal_code,
            source: details.source,
          }
        : comparable;
    }),
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
