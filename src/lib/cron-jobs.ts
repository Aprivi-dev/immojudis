import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deliverOperationalAlertNotifications } from "@/lib/operational-alerts";
import { resolveRequestId } from "@/lib/request-id";

type CronRpcClient = {
  rpc(
    name: "begin_operational_job_run",
    args: { p_job_name: string },
  ): Promise<{ data: string | null; error: { message?: string } | null }>;
  rpc(
    name: "finish_operational_job_run",
    args: {
      p_error_message: string | null;
      p_run_id: string;
      p_status: "success" | "failed";
      p_summary: Record<string, unknown>;
    },
  ): Promise<{ data: null; error: { message?: string } | null }>;
  rpc(
    name: "run_data_retention",
    args: { p_now: string },
  ): Promise<{ data: Record<string, number> | null; error: { message?: string } | null }>;
  rpc(
    name: "evaluate_operational_health",
    args: { p_now: string },
  ): Promise<{ data: Record<string, unknown> | null; error: { message?: string } | null }>;
  rpc(
    name: "evaluate_market_valuation_health" | "observe_autonomous_pipeline",
    args: { p_now: string },
  ): Promise<{ data: Record<string, unknown> | null; error: { message?: string } | null }>;
};

/** Waits between attempts when the database or the network is briefly unreachable. */
const DEFAULT_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

/** `operational_job_runs` is not part of the generated database types. */
type JobRunsReader = {
  from(table: "operational_job_runs"): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: string,
        ): {
          gte(
            column: string,
            value: string,
          ): {
            limit(count: number): Promise<{
              data: Array<{ id: string }> | null;
              error: { message?: string } | null;
            }>;
          };
        };
      };
    };
  };
};

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
    return NextResponse.json(
      {
        ok: true,
        ...result,
        requestId,
        runId,
        schedule,
      },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
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
    return NextResponse.json(
      { ok: false, error: "Scheduled job failed", code: "JOB_FAILED", requestId, runId },
      { status: 500, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
}

/** True for network blips and gateway errors that are worth retrying. */
export function isTransientError(error: unknown): boolean {
  const message = operationalErrorMessage(error).toLowerCase();
  return (
    /\b(502|503|504|520|521|522|523|524|429)\b/.test(message) ||
    /econnreset|econnrefused|etimedout|enotfound|eai_again|fetch failed|socket hang up|connection terminated|connection timed out|temporarily unavailable|network/.test(
      message,
    ) ||
    message.includes("<!doctype html") ||
    message.includes("<html")
  );
}

async function withTransientRetries<T>(
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

async function succeededRecently(jobName: string, windowHours: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    const { data, error } = await (supabaseAdmin as unknown as JobRunsReader)
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

export async function runDataRetention(now = new Date()): Promise<Record<string, unknown>> {
  const client = supabaseAdmin as unknown as CronRpcClient;
  const { data, error } = await client.rpc("run_data_retention", { p_now: now.toISOString() });
  if (error) throw new Error(error.message || "Data retention failed.");
  return { deleted: data ?? {} };
}

export async function evaluateOperationalHealth(
  now = new Date(),
): Promise<Record<string, unknown>> {
  const client = supabaseAdmin as unknown as CronRpcClient;
  const args = { p_now: now.toISOString() };
  const results = await Promise.allSettled([
    client.rpc("evaluate_operational_health", args),
    client.rpc("evaluate_market_valuation_health", args),
    client.rpc("observe_autonomous_pipeline", args),
  ]);
  // Deliver incidents even when an independent evaluator fails.
  const delivery = await deliverOperationalAlertNotifications();
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [operationalErrorMessage(result.reason)]
      : result.value.error
        ? [result.value.error.message ?? "Health evaluation failed"]
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
  return { health: data[0], valuation: data[1], pipeline: data[2], externalAlerts: delivery };
}

export function positiveNumberFromEnv(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function cronRequestAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization) return false;
  return safeEqual(authorization, `Bearer ${secret}`);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function beginRun(
  jobName: string,
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<string | null> {
  try {
    return await withTransientRetries(async () => {
      const client = supabaseAdmin as unknown as CronRpcClient;
      const { data, error } = await client.rpc("begin_operational_job_run", {
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

async function finishRun(
  runId: string | null,
  status: "success" | "failed",
  summary: Record<string, unknown>,
  errorMessage: string | null,
): Promise<void> {
  if (!runId) return;
  try {
    const client = supabaseAdmin as unknown as CronRpcClient;
    const { error } = await client.rpc("finish_operational_job_run", {
      p_error_message: errorMessage,
      p_run_id: runId,
      p_status: status,
      p_summary: summary,
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

function logCron(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ scope: "cron", timestamp: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
