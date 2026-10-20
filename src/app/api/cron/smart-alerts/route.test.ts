import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runBatch: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({
  runMonitoredCron: mocks.runMonitoredCron,
  positiveNumberFromEnv: () => undefined,
}));
vi.mock("@/lib/alert-matches", () => ({
  runSmartAlertEvaluationBatch: mocks.runBatch,
  assertSmartAlertBatchComplete: mocks.assertComplete,
}));

import { GET, maxDuration } from "./route";

describe("smart alerts cron route", () => {
  afterEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  function runHandler() {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );
    return GET(new Request("https://example.test/api/cron/smart-alerts"));
  }

  it("passe par la supervision, sous son nom, avec son rattrapage", async () => {
    mocks.runBatch.mockResolvedValueOnce({ failedUserCount: 0 });
    await runHandler();
    const [, jobName, , options] = mocks.runMonitoredCron.mock.calls[0];
    expect(jobName).toBe("smart-alerts");
    expect(options).toEqual({ catchUpSchedule: "15 8 * * *" });
    expect(maxDuration).toBe(300);
  });

  it("rend le rapport du passage après l'avoir vérifié", async () => {
    const summary = { analysedUserCount: 10, failedUserCount: 1 };
    mocks.runBatch.mockResolvedValueOnce(summary);
    const response = await runHandler();
    expect(mocks.assertComplete).toHaveBeenCalledWith(summary);
    expect(await response.json()).toEqual(summary);
  });

  it("fait échouer le passage quand trop de comptes ont échoué", async () => {
    mocks.runBatch.mockResolvedValueOnce({ analysedUserCount: 10, failedUserCount: 4 });
    mocks.assertComplete.mockImplementationOnce(() => {
      throw new Error("Alertes intelligentes : 4 compte(s) en échec sur 10 analysé(s)");
    });
    await expect(runHandler()).rejects.toThrow("4 compte(s) en échec");
  });
});
