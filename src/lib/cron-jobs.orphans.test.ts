import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  calls: [] as Array<[string, ...unknown[]]>,
  closed: [{ id: "run-old" }] as Array<{ id: string }>,
  error: null as { message: string } | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  for (const name of ["update", "eq", "lt", "gte", "select", "limit"]) {
    chain[name] = (...args: unknown[]) => {
      mocks.calls.push([name, ...args]);
      return name === "select" || name === "limit" ? terminal() : chain;
    };
  }
  function terminal() {
    const promise = Promise.resolve({ data: mocks.closed, error: mocks.error });
    return Object.assign(promise, chain);
  }
  return { supabaseAdmin: { rpc: mocks.rpc, from: () => chain } };
});
vi.mock("@/lib/operational-alerts", () => ({
  deliverOperationalAlertNotifications: vi.fn(),
}));

import { ORPHANED_RUN_AFTER_MS, closeOrphanedRuns, runMonitoredCron } from "@/lib/cron-jobs";

describe("exécutions orphelines des tâches planifiées", () => {
  beforeEach(() => {
    mocks.calls = [];
    mocks.closed = [{ id: "run-old" }];
    mocks.error = null;
    process.env.CRON_SECRET = "cron-test-secret";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.rpc.mockReset();
    delete process.env.CRON_SECRET;
  });

  it("clôt en échec les exécutions « running » plus anciennes que le seuil", async () => {
    const now = Date.parse("2026-10-23T08:00:00.000Z");

    await expect(closeOrphanedRuns("smart-alerts", now)).resolves.toBe(1);

    expect(mocks.calls).toContainEqual([
      "update",
      expect.objectContaining({ status: "failed", finished_at: "2026-10-23T08:00:00.000Z" }),
    ]);
    expect(mocks.calls).toContainEqual(["eq", "job_name", "smart-alerts"]);
    expect(mocks.calls).toContainEqual(["eq", "status", "running"]);
    expect(mocks.calls).toContainEqual([
      "lt",
      "started_at",
      new Date(now - ORPHANED_RUN_AFTER_MS).toISOString(),
    ]);
  });

  it("ne bloque jamais le passage quand le nettoyage échoue", async () => {
    mocks.error = { message: "permission denied" };
    await expect(closeOrphanedRuns("smart-alerts")).resolves.toBe(0);
  });

  it("nettoie avant d'ouvrir l'exécution du passage", async () => {
    mocks.rpc.mockResolvedValue({ data: "run-1", error: null });
    const handler = vi.fn().mockResolvedValue({ ok: 1 });

    const response = await runMonitoredCron(
      new Request("https://example.test/api/cron/x", {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
      "smart-alerts",
      handler,
      { retryDelaysMs: [0] },
    );

    expect(response.status).toBe(200);
    expect(mocks.calls.some(([name]) => name === "update")).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("begin_operational_job_run", {
      p_job_name: "smart-alerts",
    });
  });
});
