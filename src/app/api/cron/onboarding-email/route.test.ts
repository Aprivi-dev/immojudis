import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/onboarding-email-notices", () => ({
  runOnboardingEmails: mocks.run,
  assertOnboardingEmailsComplete: mocks.assertComplete,
}));

import { GET, maxDuration } from "./route";

describe("onboarding email cron route", () => {
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
    return GET(new Request("https://example.test/api/cron/onboarding-email"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "off", due: 0 });
    const response = await runHandler();
    expect(await response.json()).toEqual({ mode: "off", due: 0 });
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("onboarding-email");
    // Le rattrapage de 15:30 ne repart que si le passage de 13:30 a échoué (règle par défaut).
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
      throw new Error("Onboarding emails: 1 of 1 sends failed.");
    });
    await expect(runHandler()).rejects.toThrow("sends failed");
  });

  it("laisse 60 secondes au passage", () => {
    expect(maxDuration).toBe(60);
  });
});
