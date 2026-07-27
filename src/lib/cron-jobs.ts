import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deliverOperationalAlertNotifications } from "@/lib/operational-alerts";

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
};

export async function runMonitoredCron(
  request: Request,
  jobName: string,
  handler: () => Promise<Record<string, unknown>>,
) {
  const requestId = request.headers.get("x-request-id") || randomUUID();
  if (!cronRequestAuthorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", requestId },
      { status: 401, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }

  const startedAt = Date.now();
  const runId = await beginRun(jobName);

  try {
    const result = await handler();
    const durationMs = Date.now() - startedAt;
    await finishRun(runId, "success", result, null);
    logCron("info", { requestId, runId, jobName, durationMs, status: "success" });
    return NextResponse.json(
      {
        ok: true,
        ...result,
        requestId,
        runId,
        schedule: request.headers.get("x-vercel-cron-schedule"),
      },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled job failed";
    const durationMs = Date.now() - startedAt;
    await finishRun(runId, "failed", {}, message);
    logCron("error", { requestId, runId, jobName, durationMs, status: "failed", message });
    return NextResponse.json(
      { ok: false, error: "Scheduled job failed", code: "JOB_FAILED", requestId, runId },
      { status: 500, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
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
  const { data, error } = await client.rpc("evaluate_operational_health", {
    p_now: now.toISOString(),
  });
  if (error) throw new Error(error.message || "Operational health evaluation failed.");
  const delivery = await deliverOperationalAlertNotifications();
  return { health: data ?? {}, externalAlerts: delivery };
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

async function beginRun(jobName: string): Promise<string | null> {
  try {
    const client = supabaseAdmin as unknown as CronRpcClient;
    const { data, error } = await client.rpc("begin_operational_job_run", { p_job_name: jobName });
    if (error) throw new Error(error.message || "Unable to create job run.");
    return data;
  } catch (error) {
    logCron("error", {
      jobName,
      status: "monitoring_unavailable",
      message: error instanceof Error ? error.message : String(error),
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

function logCron(level: "info" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ scope: "cron", timestamp: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.info(line);
}
