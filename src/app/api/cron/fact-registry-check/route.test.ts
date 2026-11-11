import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFactRegistryCheckJob: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/fact-registry-check", () => ({
  runFactRegistryCheckJob: mocks.runFactRegistryCheckJob,
}));

import { GET, maxDuration } from "./route";

describe("fact registry check cron route", () => {
  afterEach(() => {
    mocks.runFactRegistryCheckJob.mockReset();
    mocks.runMonitoredCron.mockReset();
  });

  it("passe par la supervision des tâches planifiées, sous le nom attendu par cron.stale", async () => {
    mocks.runFactRegistryCheckJob.mockResolvedValueOnce({ alert: "clear" });
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );

    const response = await GET(new Request("https://example.test/api/cron/fact-registry-check"));

    expect(await response.json()).toEqual({ alert: "clear" });
    expect(mocks.runMonitoredCron).toHaveBeenCalledTimes(1);
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("fact-registry-check");
  });

  it("laisse cinq minutes à l'exécution", () => {
    expect(maxDuration).toBe(300);
  });
});
