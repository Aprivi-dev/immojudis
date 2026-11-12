import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import { DEFAULT_RETRY_DELAYS_MS, logCron, runMonitoredJob } from "@/lib/monitored-job.server";
import { resolveRequestId } from "@/lib/request-id";
import { CRON_JOBS, type CronJobName, type CronJobTriggers } from "@/lib/scheduled-jobs";

export type MonitoredCronOptions = {
  /**
   * Tâche du registre dont le rattrapage (`CRON_JOBS[…].catchUp`) s'applique, quand ce n'est pas
   * `jobName` : une route qui ne fait que déclencher un workflow, lequel écrit la vraie exécution sous ce
   * nom. Le succès récent qui rend le rattrapage inutile est cherché sous ce nom.
   */
  catchUpOf?: CronJobName;
  /** Pauses entre deux tentatives ; les tests passent `[0, 0, 0]`. */
  retryDelaysMs?: number[];
};

export type MonitoredCronRun = {
  /** Passage de rattrapage (`x-vercel-cron-schedule` = `CRON_JOBS[…].catchUp.schedule`). */
  catchUp: boolean;
};

function registeredJob(name: string): CronJobName | undefined {
  return Object.hasOwn(CRON_JOBS, name) ? (name as CronJobName) : undefined;
}

export async function runMonitoredCron(
  request: Request,
  jobName: string,
  handler: (run: MonitoredCronRun) => Promise<Record<string, unknown>>,
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
  const catchUpJob = options.catchUpOf ?? registeredJob(jobName);
  const catchUp = catchUpJob ? (CRON_JOBS[catchUpJob] as CronJobTriggers).catchUp : undefined;
  const isCatchUp = Boolean(catchUp && schedule === catchUp.schedule);
  if (
    catchUpJob &&
    isCatchUp &&
    (await succeededRecently(catchUpJob, catchUp?.successWindowHours ?? 20))
  ) {
    logCron("info", { requestId, jobName, status: 200, outcome: "catch_up_not_needed" });
    return NextResponse.json(
      { ok: true, skipped: "already_succeeded", requestId, schedule },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const outcome = await runMonitoredJob(jobName, () => handler({ catchUp: isCatchUp }), {
    retryDelaysMs,
    requestId,
  });
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
