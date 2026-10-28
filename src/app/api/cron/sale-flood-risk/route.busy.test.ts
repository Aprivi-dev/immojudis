import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSaleFloodRiskBatch: vi.fn(),
  runMonitoredJob: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/operational-alerts", () => ({ deliverOperationalAlertNotifications: vi.fn() }));
vi.mock("@/lib/sale-flood-risk-batch", () => ({
  runSaleFloodRiskBatch: mocks.runSaleFloodRiskBatch,
}));
// La supervision réelle écrit dans `operational_job_runs` : ici elle exécute la tâche et rend son résultat.
vi.mock("@/lib/monitored-job.server", () => ({ runMonitoredJob: mocks.runMonitoredJob }));

import { GET } from "./route";

describe("route planifiée du risque d’inondation : bail occupé", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "secret-de-test");
    vi.stubEnv("SALE_FLOOD_RISK_RUNNER", "vercel");
    mocks.runMonitoredJob.mockImplementation(
      async (_name: string, handler: () => Promise<Record<string, unknown>>) => ({
        ok: true,
        runId: "run-1",
        result: await handler(),
        durationMs: 1,
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.runSaleFloodRiskBatch.mockReset();
    mocks.runMonitoredJob.mockReset();
  });

  it("une autre passe tient le bail : 200 « skipped: busy », comptée comme une réussite", async () => {
    mocks.runSaleFloodRiskBatch.mockResolvedValue({ skipped: "busy" });

    const response = await GET(
      new Request("https://example.test/api/cron/sale-flood-risk", {
        headers: { authorization: "Bearer secret-de-test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, skipped: "busy" });
    // La supervision a vu une réussite (pas d'échec, donc pas d'alerte ni de reprise).
    const outcome = await mocks.runMonitoredJob.mock.results[0].value;
    expect(outcome).toMatchObject({ ok: true });
    expect(mocks.runMonitoredJob.mock.calls[0][0]).toBe("sale-flood-risk");
  });
});
