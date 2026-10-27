import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { nullableRpcArg } from "@/lib/rpc-args";

/**
 * Supervision d'une tâche planifiée hors de toute requête HTTP : début et fin d'exécution dans
 * `operational_job_runs` (lus par `cron.stale`), reprises sur les pannes passagères, clôture des exécutions
 * orphelines. `runMonitoredCron` (routes de Vercel) et les traitements lancés depuis GitHub Actions
 * (`src/jobs/sale-flood-risk-runner.ts`) partagent ce circuit.
 */

/** Waits between attempts when the database or the network is briefly unreachable. */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

/** True for network blips and gateway errors that are worth retrying. */
export function isTransientError(error: unknown): boolean {
  const message = operationalErrorMessage(error).toLowerCase();
  return (
    /\b(502|503|504|520|521|522|523|524|429)\b/.test(message) ||
    /econnreset|econnrefused|etimedout|enotfound|eai_again|fetch failed|socket hang up|connection terminated|connection timed out|temporarily unavailable|network|canceling statement due to statement timeout|deadlock detected|could not serialize/.test(
      message,
    ) ||
    message.includes("<!doctype html") ||
    message.includes("<html")
  );
}

export async function withTransientRetries<T>(
  operation: () => Promise<T>,
  delaysMs: number[],
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransientError(error)) throw error;
      onRetry?.(attempt + 1, error);
      const delay = delaysMs[attempt];
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Une fonction planifiée dure au plus 300 s : au-delà, une exécution « running » est orpheline.
 * Les alertes SQL « exécution bloquée » (`evaluate_information_agent_health`, 20 minutes) restent
 * sous ce seuil : sinon la clôture passerait avant elles et l'alerte ne s'ouvrirait jamais.
 */
export const ORPHANED_RUN_AFTER_MS = 30 * 60 * 1000;

/**
 * Clôt en échec les exécutions de ce job restées « running » (fonction interrompue avant
 * `finish_operational_job_run`). Elles faussent sinon l'historique et les contrôles qui lisent la
 * dernière exécution. Sans effet sur une exécution récente, donc sur un passage encore en cours.
 * Best-effort : une erreur ici ne doit jamais empêcher le passage.
 */
export async function closeOrphanedRuns(jobName: string, now = Date.now()): Promise<number> {
  try {
    const cutoff = new Date(now - ORPHANED_RUN_AFTER_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from("operational_job_runs")
      .update({
        status: "failed",
        error_message: "Exécution interrompue : jamais terminée, clôturée au passage suivant.",
        finished_at: new Date(now).toISOString(),
      })
      .eq("job_name", jobName)
      .eq("status", "running")
      .lt("started_at", cutoff)
      .select("id");
    if (error) throw error;
    const closed = data?.length ?? 0;
    if (closed > 0) logCron("warn", { jobName, status: "orphaned_runs_closed", closed });
    return closed;
  } catch (error) {
    logCron("warn", {
      jobName,
      status: "orphan_cleanup_failed",
      message: operationalErrorMessage(error),
    });
    return 0;
  }
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Turn an HTML error page (a gateway answer) into a one-line summary. */
function summariseHtmlError(message: string): string {
  const status = /\b(5\d\d)\b/.exec(message.replace(/<[^>]*>/g, " "))?.[1];
  return status
    ? `Supabase injoignable (HTTP ${status})`
    : "Réponse HTML inattendue du serveur (service injoignable)";
}

function boundedMessage(message: string): string {
  const trimmed = message.trim();
  if (/<!doctype html|<html[\s>]/i.test(trimmed)) return summariseHtmlError(trimmed);
  return trimmed.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : trimmed;
}

export function operationalErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return boundedMessage(error.message);
  if (typeof error === "string" && error.trim()) return boundedMessage(error);
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (parts.length) return boundedMessage([...new Set(parts)].join(" · "));
  }
  return "Scheduled job failed";
}

export async function beginRun(
  jobName: string,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<string | null> {
  try {
    return await withTransientRetries(async () => {
      const { data, error } = await supabaseAdmin.rpc("begin_operational_job_run", {
        p_job_name: jobName,
      });
      if (error) throw new Error(error.message || "Unable to create job run.");
      return data;
    }, retryDelaysMs);
  } catch (error) {
    logCron("error", {
      jobName,
      status: "monitoring_unavailable",
      message: operationalErrorMessage(error),
    });
    return null;
  }
}

export async function finishRun(
  runId: string | null,
  status: "success" | "failed",
  summary: Record<string, unknown>,
  errorMessage: string | null,
): Promise<void> {
  if (!runId) return;
  try {
    const { error } = await supabaseAdmin.rpc("finish_operational_job_run", {
      p_error_message: nullableRpcArg(errorMessage),
      p_run_id: runId,
      p_status: status,
      p_summary: summary as Json,
    });
    if (error) throw new Error(error.message || "Unable to finish job run.");
  } catch (error) {
    logCron("error", {
      runId,
      status: "monitoring_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function logCron(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ scope: "cron", timestamp: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export type MonitoredJobOutcome =
  | { ok: true; runId: string | null; result: Record<string, unknown>; durationMs: number }
  | { ok: false; runId: string | null; message: string; durationMs: number };

/** Exécute une tâche supervisée : ferme les orphelines, ouvre l'exécution, reprend les pannes passagères, la clôt. */
export async function runMonitoredJob(
  jobName: string,
  handler: () => Promise<Record<string, unknown>>,
  {
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    requestId,
  }: { retryDelaysMs?: number[]; requestId?: string } = {},
): Promise<MonitoredJobOutcome> {
  const startedAt = Date.now();
  await closeOrphanedRuns(jobName);
  let runId = await beginRun(jobName, retryDelaysMs);

  try {
    const result = await withTransientRetries(handler, retryDelaysMs, (attempt, error) =>
      logCron("warn", {
        requestId,
        jobName,
        status: "retrying",
        attempt,
        message: operationalErrorMessage(error),
      }),
    );
    const durationMs = Date.now() - startedAt;
    runId ??= await beginRun(jobName, [0]);
    await finishRun(runId, "success", result, null);
    logCron("info", {
      requestId,
      runId,
      jobName,
      durationMs,
      status: 200,
      outcome: "success",
      summary: result,
    });
    return { ok: true, runId, result, durationMs };
  } catch (error) {
    const message = operationalErrorMessage(error);
    const durationMs = Date.now() - startedAt;
    // If the database was unreachable at the start, record the failure now so
    // it is visible once the database is back.
    runId ??= await beginRun(jobName, [0, 5_000].slice(0, retryDelaysMs.length ? 2 : 1));
    await finishRun(runId, "failed", {}, message);
    logCron("error", {
      requestId,
      runId,
      jobName,
      durationMs,
      status: 500,
      outcome: "failed",
      message,
    });
    return { ok: false, runId, message, durationMs };
  }
}
