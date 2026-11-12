import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runBatch: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({
  runMonitoredCron: mocks.runMonitoredCron,
}));
vi.mock("@/lib/sale-change-monitor", () => ({ runSaleChangeMonitorBatch: mocks.runBatch }));

import { GET, maxDuration } from "./route";

describe("sale change monitor cron route", () => {
  afterEach(() => {
    mocks.runBatch.mockReset();
    mocks.runMonitoredCron.mockReset();
    vi.unstubAllEnvs();
  });

  it("passe par la supervision des tâches planifiées, avec son rattrapage de 08:45", async () => {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (_request: Request, _jobName: string, handler: () => Promise<unknown>) =>
        Response.json(await handler()),
    );
    mocks.runBatch.mockResolvedValueOnce({ ok: true });
    vi.stubEnv("SALE_CHANGE_CRON_USER_LIMIT", "25");
    await GET(new Request("https://example.test/api/cron/sale-change-monitor"));
    const [, jobName, , options] = mocks.runMonitoredCron.mock.calls[0];
    expect(jobName).toBe("sale-change-monitor");
    expect(options).toBeUndefined();
    expect(mocks.runBatch).toHaveBeenCalledWith({ userLimit: 25 });
  });

  it("déclare une durée maximale littérale pour examiner tous les comptes ayant consenti", () => {
    expect(maxDuration).toBe(300);
  });
});
