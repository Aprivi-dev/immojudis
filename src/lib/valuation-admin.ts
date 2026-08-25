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
type QueueRow = Pick<
  Database["public"]["Tables"]["auction_sale_market_estimates"]["Row"],
  "status" | "estimate" | "actionable" | "next_refresh_at" | "last_error_code" | "priority"
>;
type AttemptRow = Pick<
  Database["public"]["Tables"]["valuation_estimate_attempts"]["Row"],
  "outcome" | "error_code" | "latency_ms" | "created_at"
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
    testMapePct: number | null;
    testMedianApePct: number | null;
    intervalCoveragePct: number | null;
    intervalMeanWidthPct: number | null;
    testRows: number | null;
  };
  promotionGate: {
    passes: boolean;
    failures: string[];
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
  status: "healthy" | "degraded" | "unknown";
  driftSignals: string[];
};

export type ValuationAdminResponse = {
  checkedAt: string;
  engineVersion: "v3";
  activeModels: ValuationModelSummary[];
  recentModels: ValuationModelSummary[];
  runtime: ValuationRuntimeHealth;
  queue: ReturnType<typeof summarizeValuationQueue>;
  attempts: ReturnType<typeof summarizeValuationAttempts>;
};

export async function getValuationAdminOverview(
  authToken: string,
): Promise<ValuationAdminResponse> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const [modelsResult, estimatesResult, queueResult, attemptsResult] = await Promise.all([
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
    supabaseAdmin
      .from("auction_sale_market_estimates")
      .select("status,estimate,actionable,next_refresh_at,last_error_code,priority")
      .limit(5_000),
    supabaseAdmin
      .from("valuation_estimate_attempts")
      .select("outcome,error_code,latency_ms,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5_000),
  ]);
  if (modelsResult.error) throw modelsResult.error;
  if (estimatesResult.error) throw estimatesResult.error;
  if (queueResult.error) throw queueResult.error;
  if (attemptsResult.error) throw attemptsResult.error;

  const models = (modelsResult.data ?? []).map(summarizeModel);
  const estimates = (estimatesResult.data ?? []) as EstimateRow[];
  return {
    checkedAt: new Date().toISOString(),
    engineVersion: "v3",
    activeModels: models.filter((model) => model.status === "active"),
    recentModels: models,
    runtime: summarizeValuationRuntime(estimates),
    queue: summarizeValuationQueue((queueResult.data ?? []) as QueueRow[]),
    attempts: summarizeValuationAttempts((attemptsResult.data ?? []) as AttemptRow[]),
  };
}

export function summarizeValuationQueue(rows: QueueRow[], now = new Date()) {
  const served = rows.filter((row) => row.estimate != null).length;
  const actionable = rows.filter((row) => row.estimate != null && row.actionable).length;
  const dueRows = rows.filter((row) => new Date(row.next_refresh_at).getTime() <= now.getTime());
  const oldestDueAt = dueRows
    .map((row) => new Date(row.next_refresh_at).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0];
  const byStatus: Record<string, number> = {};
  const byErrorCode: Record<string, number> = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.last_error_code) {
      byErrorCode[row.last_error_code] = (byErrorCode[row.last_error_code] ?? 0) + 1;
    }
  }
  const coveragePct = rows.length ? round((served / rows.length) * 100, 1) : null;
  const actionableCoveragePct = rows.length ? round((actionable / rows.length) * 100, 1) : null;
  const oldestDueMinutes = oldestDueAt
    ? Math.max(0, round((now.getTime() - oldestDueAt) / 60_000, 1))
    : null;
  return {
    total: rows.length,
    served,
    withoutEstimate: rows.length - served,
    actionable,
    coveragePct,
    actionableCoveragePct,
    due: dueRows.length,
    oldestDueMinutes,
    highPriority: rows.filter((row) => row.priority >= 80).length,
    byStatus,
    byErrorCode,
    status:
      rows.length === 0
        ? ("unknown" as const)
        : (coveragePct ?? 0) < 95 || (oldestDueMinutes ?? 0) > 15
          ? ("degraded" as const)
          : ("healthy" as const),
  };
}

export function summarizeValuationAttempts(rows: AttemptRow[]) {
  const byOutcome: Record<string, number> = {};
  const byErrorCode: Record<string, number> = {};
  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    if (row.error_code) byErrorCode[row.error_code] = (byErrorCode[row.error_code] ?? 0) + 1;
  }
  const completed = rows.filter((row) => row.outcome !== "superseded");
  const successful = completed.filter((row) => row.outcome === "ready").length;
  return {
    windowHours: 24 as const,
    total: rows.length,
    successRatePct: completed.length ? round((successful / completed.length) * 100, 1) : null,
    averageLatencyMs: average(rows.map((row) => row.latency_ms)),
    byOutcome,
    byErrorCode,
  };
}

export function summarizeValuationRuntime(rows: EstimateRow[]): ValuationRuntimeHealth {
  const count = rows.length;
  const bySegment: Record<string, number> = {};
  for (const row of rows) bySegment[row.segment] = (bySegment[row.segment] ?? 0) + 1;

  const actionableSharePct = share(rows, (row) => row.actionable);
  const averageConfidenceScore = average(rows.map((row) => row.confidence_score));
  const averageLatencyMs = average(rows.map((row) => row.latency_ms));
  const driftSignals = runtimeDriftSignals({
    count,
    actionableSharePct,
    averageConfidenceScore,
    averageLatencyMs,
  });
  return {
    windowHours: 24,
    estimates: count,
    hybridSharePct: share(rows, (row) => row.engine_kind === "hybrid_lightgbm"),
    actionableSharePct,
    averageConfidenceScore,
    averageComparableCount: average(rows.map((row) => row.comparable_count)),
    averageLatencyMs,
    bySegment,
    status: count === 0 ? "unknown" : driftSignals.length ? "degraded" : "healthy",
    driftSignals,
  };
}

export function evaluateValuationPromotionGate(metrics: {
  testMapePct: number | null;
  testMedianApePct: number | null;
  intervalCoveragePct: number | null;
  intervalMeanWidthPct: number | null;
  testRows: number | null;
}): { passes: boolean; failures: string[] } {
  const failures: string[] = [];
  if (metrics.testRows == null || metrics.testRows < 50)
    failures.push("moins de 50 lignes de test");
  if (metrics.testMedianApePct == null || metrics.testMedianApePct > 30) {
    failures.push("erreur médiane > 30 % ou absente");
  }
  if (metrics.testMapePct == null || metrics.testMapePct > 40) {
    failures.push("MAPE > 40 % ou absente");
  }
  if (metrics.intervalCoveragePct == null || metrics.intervalCoveragePct < 72) {
    failures.push("couverture < 72 % ou absente");
  }
  if (metrics.intervalMeanWidthPct == null || metrics.intervalMeanWidthPct > 110) {
    failures.push("intervalle > 110 % ou absent");
  }
  return { passes: failures.length === 0, failures };
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
  const summarizedMetrics = {
    testMapePct: numberValue(metrics.test_mape_pct),
    testMedianApePct: numberValue(metrics.test_median_ape_pct),
    intervalCoveragePct: numberValue(metrics.interval_coverage_pct),
    intervalMeanWidthPct: numberValue(metrics.interval_mean_width_pct),
    testRows: numberValue(metrics.test_rows),
  };
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
    metrics: summarizedMetrics,
    promotionGate: evaluateValuationPromotionGate(summarizedMetrics),
  };
}

function runtimeDriftSignals({
  count,
  actionableSharePct,
  averageConfidenceScore,
  averageLatencyMs,
}: {
  count: number;
  actionableSharePct: number | null;
  averageConfidenceScore: number | null;
  averageLatencyMs: number | null;
}): string[] {
  if (count === 0) return ["Aucune estimation sur les dernières 24 h."];
  const signals: string[] = [];
  if (actionableSharePct != null && actionableSharePct < 50) {
    signals.push("Moins de 50 % des estimations sont actionnables.");
  }
  if (averageConfidenceScore != null && averageConfidenceScore < 55) {
    signals.push("La confiance moyenne est inférieure à 55.");
  }
  if (averageLatencyMs != null && averageLatencyMs > 1_500) {
    signals.push("La latence moyenne dépasse 1,5 seconde.");
  }
  return signals;
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
