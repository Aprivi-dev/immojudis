import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { getMarketEstimate, type MarketContext, type MarketEstimate } from "@/lib/market.functions";
import { getMarketValuationSurfaces } from "@/lib/surface";

type StoredEstimateRow = Database["public"]["Tables"]["auction_sale_market_estimates"]["Row"];
type StoredEstimateUpdate = Database["public"]["Tables"]["auction_sale_market_estimates"]["Update"];
type AuctionSaleRow = Database["public"]["Tables"]["auction_sales"]["Row"];

const SALE_INPUT_COLUMNS = [
  "id",
  "title",
  "address",
  "city",
  "postal_code",
  "property_type",
  "latitude",
  "longitude",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "rooms_count",
  "bedrooms_count",
  "updated_at",
] as const;

type SaleValuationSource = Pick<AuctionSaleRow, (typeof SALE_INPUT_COLUMNS)[number]>;

export type SaleValuationInput = {
  saleId: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  propertyType: string | null;
  surfaceKind: string | null;
  surfaceScope: string | null;
  surfaceM2: number | null;
  landSurfaceM2: number | null;
  roomsCount: number | null;
  surfaceEstimated: boolean;
  surfaceAssumption: string | null;
  surfaceUncertaintyPct: number | null;
};

export type SaleValuationPrecomputeResult = {
  scanned: number;
  claimed: number;
  ready: number;
  insufficientData: number;
  failed: number;
  errors: Array<{ saleId: string; error: string }>;
};

export function buildSaleValuationInput(sale: SaleValuationSource): SaleValuationInput {
  const surfaces = getMarketValuationSurfaces(sale);
  return {
    saleId: sale.id,
    lat: sale.latitude,
    lng: sale.longitude,
    address: sale.address,
    city: sale.city,
    postalCode: sale.postal_code,
    propertyType: sale.property_type,
    surfaceKind: surfaces.surfaceKind,
    surfaceScope: surfaces.surfaceScope,
    surfaceM2: surfaces.builtSurfaceM2,
    landSurfaceM2: surfaces.landSurfaceM2,
    roomsCount: sale.rooms_count,
    surfaceEstimated: surfaces.builtSurfaceEstimated,
    surfaceAssumption: surfaces.builtSurfaceAssumption,
    surfaceUncertaintyPct: surfaces.builtSurfaceUncertaintyPct,
  };
}

export function saleValuationFingerprint(
  input: SaleValuationInput,
  sourceUpdatedAt: string | null,
): string {
  return createHash("sha256").update(JSON.stringify({ input, sourceUpdatedAt })).digest("hex");
}

export function marketContextFromStoredRow(row: StoredEstimateRow | null): MarketContext {
  const estimate = storedEstimate(row?.estimate ?? null);
  if (estimate) {
    return { ok: true, error: null, estimate };
  }

  if (!row) {
    return {
      ok: false,
      error: "Estimation pré-calculée en attente de préparation.",
      estimate: null,
    };
  }

  const preparing = row.status === "pending" || row.status === "processing";
  return {
    ok: false,
    error: preparing
      ? "Estimation en cours de préparation."
      : row.error_message || "Estimation pré-calculée indisponible.",
    estimate: null,
  };
}

export async function getStoredSaleMarketContext(saleId: string): Promise<MarketContext> {
  const { data, error } = await supabaseAdmin
    .from("auction_sale_market_estimates")
    .select("*")
    .eq("auction_sale_id", saleId)
    .maybeSingle();

  if (error) throw error;
  return marketContextFromStoredRow(data);
}

export async function getPrecomputedMarketEstimate(saleId: string): Promise<MarketEstimate | null> {
  return (await getStoredSaleMarketContext(saleId)).estimate;
}

export async function runSaleValuationPrecomputeBatch({
  limit = 8,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
} = {}): Promise<SaleValuationPrecomputeResult> {
  const batchLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  const nowIso = now.toISOString();
  const processingLeaseUntil = addMilliseconds(now, 30 * 60 * 1000).toISOString();
  const { data: dueRows, error: dueError } = await supabaseAdmin
    .from("auction_sale_market_estimates")
    .select("*")
    .lte("next_refresh_at", nowIso)
    .order("next_refresh_at", { ascending: true })
    .limit(batchLimit);

  if (dueError) throw dueError;
  if (!dueRows?.length) return emptyBatchResult();

  const saleIds = dueRows.map((row) => row.auction_sale_id);
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("auction_sales")
    .select(SALE_INPUT_COLUMNS.join(","))
    .in("id", saleIds);
  if (salesError) throw salesError;

  const salesById = new Map(
    ((sales ?? []) as unknown as SaleValuationSource[]).map((sale) => [sale.id, sale]),
  );
  const result = emptyBatchResult();
  result.scanned = dueRows.length;

  for (const row of dueRows) {
    const sale = salesById.get(row.auction_sale_id);
    if (!sale) continue;

    const input = buildSaleValuationInput(sale);
    const fingerprint = saleValuationFingerprint(input, sale.updated_at);
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("auction_sale_market_estimates")
      .update({
        status: "processing",
        input_fingerprint: fingerprint,
        source_updated_at: sale.updated_at,
        error_message: null,
        attempt_count: row.attempt_count + 1,
        last_started_at: nowIso,
        next_refresh_at: processingLeaseUntil,
      })
      .eq("auction_sale_id", sale.id)
      .lte("next_refresh_at", nowIso)
      .select("auction_sale_id")
      .maybeSingle();

    if (claimError) {
      result.failed += 1;
      result.errors.push({ saleId: sale.id, error: claimError.message });
      continue;
    }
    if (!claimed) continue;
    result.claimed += 1;

    try {
      const context = await getMarketEstimate(input, {
        userId: null,
        auctionSaleId: sale.id,
      });
      if (!context.estimate) {
        await updateStoredEstimate(sale.id, {
          status: "insufficient_data",
          input_fingerprint: fingerprint,
          source_updated_at: sale.updated_at,
          estimate: null,
          error_message: context.error || "Données insuffisantes pour produire une estimation.",
          value_p10_eur: null,
          value_p50_eur: null,
          value_p90_eur: null,
          confidence_score: null,
          comparable_count: 0,
          actionable: false,
          next_refresh_at: addMilliseconds(now, 24 * 60 * 60 * 1000).toISOString(),
        });
        result.insufficientData += 1;
        continue;
      }

      const estimate = context.estimate;
      if (!estimate.estimatedValueEur || estimate.estimatedValueEur <= 0) {
        await updateStoredEstimate(sale.id, {
          status: "insufficient_data",
          input_fingerprint: fingerprint,
          source_updated_at: sale.updated_at,
          estimate: null,
          error_message:
            estimate.qualityWarnings[0] ||
            "Les données disponibles ne permettent pas encore de calculer une valeur.",
          value_p10_eur: null,
          value_p50_eur: null,
          value_p90_eur: null,
          confidence_score: estimate.qualityScore,
          comparable_count: estimate.sampleSize,
          actionable: false,
          next_refresh_at: addMilliseconds(now, 24 * 60 * 60 * 1000).toISOString(),
        });
        result.insufficientData += 1;
        continue;
      }

      await updateStoredEstimate(sale.id, {
        status: "ready",
        input_fingerprint: fingerprint,
        source_updated_at: sale.updated_at,
        estimate: estimate as unknown as Json,
        error_message: null,
        engine_version: estimate.engineVersion ?? "v3",
        engine_kind: estimate.engineKind ?? "comparable_ensemble",
        model_version_id: estimate.modelVersionId ?? null,
        model_version: estimate.modelVersion ?? null,
        segment: estimate.segment ?? null,
        value_p10_eur: estimate.estimatedValueLowEur ?? null,
        value_p50_eur: estimate.estimatedValueEur ?? null,
        value_p90_eur: estimate.estimatedValueHighEur ?? null,
        confidence_score: estimate.qualityScore,
        comparable_count: estimate.sampleSize,
        actionable: estimate.actionable === true,
        computed_at: new Date().toISOString(),
        next_refresh_at: addMilliseconds(now, 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      result.ready += 1;
    } catch (error) {
      const message = errorMessage(error);
      await updateStoredEstimate(sale.id, {
        status: "failed",
        input_fingerprint: fingerprint,
        source_updated_at: sale.updated_at,
        error_message: message,
        next_refresh_at: addMilliseconds(now, 60 * 60 * 1000).toISOString(),
      });
      result.failed += 1;
      result.errors.push({ saleId: sale.id, error: message });
    }
  }

  return result;
}

async function updateStoredEstimate(saleId: string, update: StoredEstimateUpdate) {
  const { error } = await supabaseAdmin
    .from("auction_sale_market_estimates")
    .update(update)
    .eq("auction_sale_id", saleId);
  if (error) throw error;
}

function storedEstimate(value: Json | null): MarketEstimate | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  return value as unknown as MarketEstimate;
}

function emptyBatchResult(): SaleValuationPrecomputeResult {
  return { scanned: 0, claimed: 0, ready: 0, insufficientData: 0, failed: 0, errors: [] };
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Échec du calcul de l'estimation.";
  return message.slice(0, 500);
}
