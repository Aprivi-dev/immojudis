import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import type { MarketPropertySegment } from "@/lib/market-estimation-engine";

type SupportedSegment = Exclude<MarketPropertySegment, "unsupported">;
type AuditedSegment = SupportedSegment | "parking";
type ModelRow = Database["public"]["Tables"]["valuation_model_versions"]["Row"];

export type ActiveValuationModel = Pick<
  ModelRow,
  | "id"
  | "version"
  | "segment"
  | "framework"
  | "feature_names"
  | "artifact"
  | "calibration"
  | "training_metrics"
>;

const MODEL_CACHE_TTL_MS = 5 * 60 * 1_000;
const modelCache = new Map<
  SupportedSegment,
  { expiresAt: number; model: ActiveValuationModel | null }
>();

export async function loadActiveValuationModel(
  segment: SupportedSegment,
): Promise<ActiveValuationModel | null> {
  if (!valuationRegistryConfigured()) return null;
  const cached = modelCache.get(segment);
  if (cached && cached.expiresAt > Date.now()) return cached.model;

  try {
    const { data, error } = await supabaseAdmin
      .from("valuation_model_versions")
      .select("id,version,segment,framework,feature_names,artifact,calibration,training_metrics")
      .eq("model_key", "immojudis_market_value")
      .eq("segment", segment)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    const model = (data as ActiveValuationModel | null) ?? null;
    modelCache.set(segment, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, model });
    return model;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[valuation] modèle actif indisponible pour ${segment}: ${message}`);
    modelCache.set(segment, { expiresAt: Date.now() + 30_000, model: null });
    return null;
  }
}

export function clearValuationModelCache(): void {
  modelCache.clear();
}

export async function recordValuationEstimate(input: {
  userId: string | null;
  auctionSaleId?: string | null;
  modelVersionId?: string | null;
  engineVersion: string;
  engineKind: "comparable_ensemble" | "hybrid_lightgbm";
  segment: AuditedSegment;
  marketCell?: string | null;
  requestInput: Record<string, unknown>;
  result: Record<string, unknown>;
  valueP10Eur?: number | null;
  valueP50Eur?: number | null;
  valueP90Eur?: number | null;
  confidenceScore?: number | null;
  comparableCount: number;
  actionable: boolean;
  latencyMs: number;
}): Promise<void> {
  if (!valuationRegistryConfigured()) return;
  const inputSnapshot = redactValuationInput(input.requestInput);
  try {
    const { error } = await supabaseAdmin.from("valuation_estimates").insert({
      user_id: input.userId,
      auction_sale_id: input.auctionSaleId ?? null,
      model_version_id: input.modelVersionId ?? null,
      engine_version: input.engineVersion,
      engine_kind: input.engineKind,
      segment: input.segment,
      market_cell: input.marketCell ?? null,
      request_fingerprint: fingerprint(inputSnapshot),
      input_snapshot: inputSnapshot as Json,
      result_snapshot: input.result as Json,
      value_p10_eur: input.valueP10Eur ?? null,
      value_p50_eur: input.valueP50Eur ?? null,
      value_p90_eur: input.valueP90Eur ?? null,
      confidence_score: input.confidenceScore ?? null,
      comparable_count: input.comparableCount,
      actionable: input.actionable,
      latency_ms: input.latencyMs,
    });
    if (error) throw error;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[valuation] journalisation ignorée: ${message}`);
  }
}

function redactValuationInput(input: Record<string, unknown>): Record<string, unknown> {
  const latitude = finiteNumber(input.lat);
  const longitude = finiteNumber(input.lng);
  return {
    auctionSaleId: typeof input.saleId === "string" ? input.saleId : null,
    city: typeof input.city === "string" ? input.city : null,
    postalCode: typeof input.postalCode === "string" ? input.postalCode : null,
    propertyType: typeof input.propertyType === "string" ? input.propertyType : null,
    surfaceKind: typeof input.surfaceKind === "string" ? input.surfaceKind : null,
    surfaceScope: typeof input.surfaceScope === "string" ? input.surfaceScope : null,
    surfaceM2: finiteNumber(input.surfaceM2),
    landSurfaceM2: finiteNumber(input.landSurfaceM2),
    roomsCount: finiteNumber(input.roomsCount),
    latitude: latitude == null ? null : round(latitude, 4),
    longitude: longitude == null ? null : round(longitude, 4),
    surfaceEstimated: input.surfaceEstimated === true,
  };
}

function fingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function valuationRegistryConfigured(): boolean {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  return Boolean(url?.trim() && key?.trim());
}
