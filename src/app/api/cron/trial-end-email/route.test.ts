import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/trial-end-notices", () => ({
  runTrialEndNotices: mocks.run,
  assertTrialEndNoticesComplete: mocks.assertComplete,
}));

import { GET, maxDuration } from "./route";

describe("trial end email cron route", () => {
  afterEach(() => {
    mocks.run.mockReset();
    mocks.runMonitoredCron.mockReset();
    mocks.assertComplete.mockReset();
  });

  function runHandler() {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );
    return GET(new Request("https://example.test/api/cron/trial-end-email"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "off", due: 0 });
    const response = await runHandler();
    expect(await response.json()).toEqual({ mode: "off", due: 0 });
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("trial-end-email");
  });

  it("déclare le rattrapage de 14:30, qui ne repart que si le passage de 12:30 a échoué", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "off", due: 0 });
    await runHandler();
    expect(mocks.runMonitoredCron.mock.calls[0][3]).toBeUndefined();
  });

  it("lance le passage et vérifie qu'il est complet", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "on", due: 1, sent: 1 });
    await runHandler();
    expect(mocks.assertComplete).toHaveBeenCalledWith({ mode: "on", due: 1, sent: 1 });
  });

  it("fait échouer la tâche quand le passage n'est pas complet", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "on", due: 1, failed: 1 });
    mocks.assertComplete.mockImplementationOnce(() => {
      throw new Error("Fin d'essai : 1 envoi(s) en échec sur 1.");
    });
    await expect(runHandler()).rejects.toThrow("en échec");
  });

  it("laisse 60 secondes au passage", () => {
    expect(maxDuration).toBe(60);
  });
});
