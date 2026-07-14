import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";

type ModelRow = Database["public"]["Tables"]["valuation_model_versions"]["Row"];
type EstimateRow = Pick<
  Database["public"]["Tables"]["valuation_estimates"]["Row"],
  | "engine_kind"
  | "segment"
  | "confidence_score"
  | "comparable_count"
  | "actionable"
  | "latency_ms"
  | "created_at"
>;

export type ValuationModelSummary = Pick<
  ModelRow,
  | "id"
  | "version"
  | "segment"
  | "framework"
  | "status"
  | "training_rows"
  | "training_period_start"
  | "training_period_end"
  | "trained_at"
  | "activated_at"
  | "created_at"
> & {
  metrics: {
    testMedianApePct: number | null;
    intervalCoveragePct: number | null;
    testRows: number | null;
  };
};

export type ValuationRuntimeHealth = {
  windowHours: 24;
  estimates: number;
  hybridSharePct: number | null;
  actionableSharePct: number | null;
  averageConfidenceScore: number | null;
  averageComparableCount: number | null;
  averageLatencyMs: number | null;
  bySegment: Record<string, number>;
};

export type ValuationAdminResponse = {
  checkedAt: string;
  engineVersion: "v3";
  activeModels: ValuationModelSummary[];
  recentModels: ValuationModelSummary[];
  runtime: ValuationRuntimeHealth;
};

export async function getValuationAdminOverview(
  authToken: string,
): Promise<ValuationAdminResponse> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const [modelsResult, estimatesResult] = await Promise.all([
    supabaseAdmin
      .from("valuation_model_versions")
      .select(
        "id,version,segment,framework,status,training_metrics,training_rows,training_period_start,training_period_end,trained_at,activated_at,created_at",
      )
      .eq("model_key", "immojudis_market_value")
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("valuation_estimates")
      .select(
        "engine_kind,segment,confidence_score,comparable_count,actionable,latency_ms,created_at",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2_000),
  ]);
  if (modelsResult.error) throw modelsResult.error;
  if (estimatesResult.error) throw estimatesResult.error;

  const models = (modelsResult.data ?? []).map(summarizeModel);
  const estimates = (estimatesResult.data ?? []) as EstimateRow[];
  return {
    checkedAt: new Date().toISOString(),
    engineVersion: "v3",
    activeModels: models.filter((model) => model.status === "active"),
    recentModels: models,
    runtime: summarizeValuationRuntime(estimates),
  };
}

export function summarizeValuationRuntime(rows: EstimateRow[]): ValuationRuntimeHealth {
  const count = rows.length;
  const bySegment: Record<string, number> = {};
  for (const row of rows) bySegment[row.segment] = (bySegment[row.segment] ?? 0) + 1;

  return {
    windowHours: 24,
    estimates: count,
    hybridSharePct: share(rows, (row) => row.engine_kind === "hybrid_lightgbm"),
    actionableSharePct: share(rows, (row) => row.actionable),
    averageConfidenceScore: average(rows.map((row) => row.confidence_score)),
    averageComparableCount: average(rows.map((row) => row.comparable_count)),
    averageLatencyMs: average(rows.map((row) => row.latency_ms)),
    bySegment,
  };
}

function summarizeModel(row: {
  id: string;
  version: string;
  segment: string;
  framework: string;
  status: string;
  training_metrics: Json;
  training_rows: number | null;
  training_period_start: string | null;
  training_period_end: string | null;
  trained_at: string | null;
  activated_at: string | null;
  created_at: string;
}): ValuationModelSummary {
  const metrics = jsonObject(row.training_metrics);
  return {
    id: row.id,
    version: row.version,
    segment: row.segment,
    framework: row.framework,
    status: row.status,
    training_rows: row.training_rows,
    training_period_start: row.training_period_start,
    training_period_end: row.training_period_end,
    trained_at: row.trained_at,
    activated_at: row.activated_at,
    created_at: row.created_at,
    metrics: {
      testMedianApePct: numberValue(metrics.test_median_ape_pct),
      intervalCoveragePct: numberValue(metrics.interval_coverage_pct),
      testRows: numberValue(metrics.test_rows),
    },
  };
}

function share<T>(rows: T[], predicate: (row: T) => boolean): number | null {
  if (!rows.length) return null;
  return round((rows.filter(predicate).length / rows.length) * 100, 1);
}

function average(values: Array<number | null>): number | null {
  const available = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (!available.length) return null;
  return round(available.reduce((sum, value) => sum + value, 0) / available.length, 1);
}

function jsonObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : {};
}

function numberValue(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
