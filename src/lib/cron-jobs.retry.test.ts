import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  recentSuccess: false,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    limit: async () => ({ data: mocks.recentSuccess ? [{ id: "run-0" }] : [], error: null }),
  };
  return { supabaseAdmin: { rpc: mocks.rpc, from: () => chain } };
});
vi.mock("@/lib/operational-alerts", () => ({
  deliverOperationalAlertNotifications: vi.fn(),
}));

import { isTransientError, operationalErrorMessage, runMonitoredCron } from "@/lib/cron-jobs";

const gatewayPage = `<!DOCTYPE html><html><head><title>sgpakxtyvenlpeihuucm.supabase.co | 522: Connection timed out</title></head><body><h1>Connection timed out Error code 522</h1></body></html>`;

function cronRequest(schedule?: string) {
  return new Request("https://example.test/api/cron/test", {
    headers: {
      authorization: "Bearer cron-test-secret",
      ...(schedule ? { "x-vercel-cron-schedule": schedule } : {}),
    },
  });
}

describe("cron retries and catch-up", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-test-secret";
    mocks.recentSuccess = false;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.rpc.mockReset();
    delete process.env.CRON_SECRET;
  });

  it("résume une page HTML de passerelle en une ligne lisible", () => {
    const message = operationalErrorMessage(new Error(gatewayPage));
    expect(message).toBe("Supabase injoignable (HTTP 522)");
    expect(message).not.toMatch(/doctype/i);
  });

  it("reconnaît les erreurs passagères et pas les erreurs métier", () => {
    expect(isTransientError(new Error(gatewayPage))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("permission denied for table user_profiles"))).toBe(false);
  });

  it("réessaie le démarrage et le traitement quand la base est brièvement injoignable", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: gatewayPage } })
      .mockResolvedValue({ data: "run-1", error: null });
    const handler = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue({ evaluated: 3 });

    const response = await runMonitoredCron(cronRequest(), "smart-alerts", handler, {
      retryDelaysMs: [0, 0, 0],
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, evaluated: 3, runId: "run-1" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("ne réessaie pas une erreur métier", async () => {
    mocks.rpc.mockResolvedValue({ data: "run-1", error: null });
    const handler = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValue(new Error("permission denied for table user_profiles"));

    const response = await runMonitoredCron(cronRequest(), "smart-alerts", handler, {
      retryDelaysMs: [0, 0, 0],
    });

    expect(response.status).toBe(500);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("enregistre quand même l'échec quand le démarrage était impossible", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "begin_operational_job_run" && mocks.rpc.mock.calls.length <= 4
        ? { data: null, error: { message: "fetch failed" } }
        : { data: "run-late", error: null },
    );
    const handler = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValue(new Error("permission denied"));

    await runMonitoredCron(cronRequest(), "smart-alerts", handler, { retryDelaysMs: [0, 0, 0] });

    const finishCall = mocks.rpc.mock.calls.find(([name]) => name === "finish_operational_job_run");
    expect(finishCall?.[1]).toMatchObject({
      p_run_id: "run-late",
      p_status: "failed",
      p_error_message: "permission denied",
    });
  });

  it("le passage de rattrapage ne refait rien si le job a déjà réussi", async () => {
    mocks.recentSuccess = true;
    const handler = vi.fn();

    const response = await runMonitoredCron(cronRequest("15 8 * * *"), "smart-alerts", handler, {
      catchUpSchedule: "15 8 * * *",
    });

    expect(await response.json()).toMatchObject({ ok: true, skipped: "already_succeeded" });
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("le passage de rattrapage s'exécute quand le passage du matin a échoué", async () => {
    mocks.rpc.mockResolvedValue({ data: "run-2", error: null });
    const handler = vi.fn().mockResolvedValue({ evaluated: 1 });

    const response = await runMonitoredCron(cronRequest("15 8 * * *"), "smart-alerts", handler, {
      catchUpSchedule: "15 8 * * *",
      retryDelaysMs: [0],
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
