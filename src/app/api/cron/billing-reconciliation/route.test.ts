import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runBillingReconciliationJob: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/billing-reconciliation", () => ({
  runBillingReconciliationJob: mocks.runBillingReconciliationJob,
}));

import { GET, maxDuration } from "./route";

describe("billing reconciliation cron route", () => {
  afterEach(() => {
    mocks.runBillingReconciliationJob.mockReset();
    mocks.runMonitoredCron.mockReset();
  });

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.runBillingReconciliationJob.mockResolvedValueOnce({ discrepancyCount: 0 });
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );

    const response = await GET(new Request("https://example.test/api/cron/billing-reconciliation"));

    expect(await response.json()).toEqual({ discrepancyCount: 0 });
    expect(mocks.runMonitoredCron).toHaveBeenCalledTimes(1);
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("billing-reconciliation");
  });

  it("laisse cinq minutes à l'exécution", () => {
    expect(maxDuration).toBe(300);
  });
});
