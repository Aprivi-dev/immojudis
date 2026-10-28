import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import {
  DEFAULT_RETRY_DELAYS_MS,
  logCron,
  operationalErrorMessage,
  runMonitoredJob,
} from "@/lib/monitored-job.server";
import { deliverOperationalAlertNotifications } from "@/lib/operational-alerts";
import { resolveRequestId } from "@/lib/request-id";

export {
  ORPHANED_RUN_AFTER_MS,
  closeOrphanedRuns,
  isTransientError,
  operationalErrorMessage,
} from "@/lib/monitored-job.server";

export type MonitoredCronOptions = {
  /**
   * Cron expression of the catch-up schedule in `vercel.json`. A call made on
   * that schedule exits at once when the job already succeeded recently.
   */
  catchUpSchedule?: string;
  /** Window in which an earlier success makes the catch-up call a no-op. */
  catchUpSuccessWindowHours?: number;
  /** Pauses between attempts; tests pass `[0, 0, 0]`. */
  retryDelaysMs?: number[];
};

export async function runMonitoredCron(
  request: Request,
  jobName: string,
  handler: () => Promise<Record<string, unknown>>,
  options: MonitoredCronOptions = {},
) {
  const startedAt = Date.now();
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  if (!cronRequestAuthorized(request)) {
    logCron("warn", {
      requestId,
      jobName,
      durationMs: Date.now() - startedAt,
      status: 401,
      outcome: "unauthorized",
    });
    return NextResponse.json(
      { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", requestId },
      { status: 401, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const schedule = request.headers.get("x-vercel-cron-schedule");
  if (
    options.catchUpSchedule &&
    schedule === options.catchUpSchedule &&
    (await succeededRecently(jobName, options.catchUpSuccessWindowHours ?? 20))
  ) {
    logCron("info", { requestId, jobName, status: 200, outcome: "catch_up_not_needed" });
    return NextResponse.json(
      { ok: true, skipped: "already_succeeded", requestId, schedule },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const outcome = await runMonitoredJob(jobName, handler, { retryDelaysMs, requestId });
  if (outcome.ok) {
    return NextResponse.json(
      {
        ok: true,
        ...outcome.result,
        requestId,
        runId: outcome.runId,
        schedule,
      },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
  return NextResponse.json(
    {
      ok: false,
      error: "Scheduled job failed",
      code: "JOB_FAILED",
      requestId,
      runId: outcome.runId,
    },
    { status: 500, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

async function succeededRecently(jobName: string, windowHours: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("operational_job_runs")
      .select("id")
      .eq("job_name", jobName)
      .eq("status", "success")
      .gte("started_at", since)
      .limit(1);
    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function runDataRetention(now = new Date()): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin.rpc("run_data_retention", {
    p_now: now.toISOString(),
  });
  if (error) throw new Error(error.message || "Data retention failed.");
  // Each purge is isolated in the database: the others have run and are committed, but a failed
  // one must still fail the monitored job (it stays in the report for the operator).
  const purgeErrors =
    data && typeof data === "object" && !Array.isArray(data) ? data.purge_errors : null;
  if (purgeErrors && typeof purgeErrors === "object" && !Array.isArray(purgeErrors)) {
    const failed = Object.entries(purgeErrors)
      .map(([purge, sqlstate]) => `${purge} (${String(sqlstate)})`)
      .join(", ");
    if (failed) throw new Error(`Data retention: purge failed: ${failed}.`);
  }
  // Journal du préavis de fin d'offre (migration 20261102140000) : purge propre, hors run_data_retention.
  // Une fonction absente (migration pas encore appliquée) n'est pas une panne.
  const noticePurge = await supabaseAdmin.rpc("purge_launch_offer_end_notices");
  if (noticePurge.error && !isMissingFunctionError(noticePurge.error)) {
    throw new Error(`Data retention: purge failed: purge_launch_offer_end_notices.`);
  }
  return {
    deleted: {
      ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
      ...(noticePurge.error ? {} : { launch_offer_end_notices: noticePurge.data ?? 0 }),
    },
  };
}

/** Position de `evaluate_information_agent_health` dans la liste des évaluations ci-dessous. */
const INFORMATION_AGENT_HEALTH_INDEX = 3;

/** « La fonction n'existe pas » : `PGRST202` (cache du schéma de PostgREST) ou `42883` (PostgreSQL). */
function isMissingFunctionError(error: { code?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

export async function evaluateOperationalHealth(
  now = new Date(),
): Promise<Record<string, unknown>> {
  const args = { p_now: now.toISOString() };
  const results = await Promise.allSettled([
    supabaseAdmin.rpc("evaluate_operational_health", args),
    supabaseAdmin.rpc("evaluate_market_valuation_health", args),
    supabaseAdmin.rpc("observe_autonomous_pipeline", args),
    // Progression de l'agent d'information (mission en envoi, réponse en file, exécution bloquée),
    // évaluation séparée de evaluate_operational_health.
    supabaseAdmin.rpc("evaluate_information_agent_health", args),
  ]);
  // Deliver incidents even when an independent evaluator fails.
  const delivery = await deliverOperationalAlertNotifications();
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [operationalErrorMessage(result.reason)]
      : result.value.error
        ? // Évaluation de l'agent d'information pas encore migrée (code déployé avant la migration) :
          // elle est absente, pas en échec, et ne doit pas faire échouer la supervision du reste.
          index === INFORMATION_AGENT_HEALTH_INDEX && isMissingFunctionError(result.value.error)
          ? []
          : [result.value.error.message ?? "Health evaluation failed"]
        : [],
  );
  if (!delivery.configured) {
    failures.push("No external operational alert channel is configured.");
  }
  if (delivery.failed > 0) {
    failures.push(`${delivery.failed} external operational alert delivery(ies) failed.`);
  }
  if (failures.length) throw new Error(failures.join("; "));
  const data = results.map((result) =>
    result.status === "fulfilled" ? (result.value.data ?? {}) : {},
  );
  return {
    health: data[0],
    valuation: data[1],
    pipeline: data[2],
    informationAgent: data[3],
    externalAlerts: delivery,
  };
}

export function positiveNumberFromEnv(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
