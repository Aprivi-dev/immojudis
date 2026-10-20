import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  confirmations: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({
  runMonitoredCron: mocks.runMonitoredCron,
  positiveNumberFromEnv: () => undefined,
}));
vi.mock("@/lib/alert-notifications", () => ({
  dispatchDueAlertNotifications: mocks.dispatch,
  assertAlertNotificationDispatchComplete: mocks.assertComplete,
}));
vi.mock("@/lib/commercial-acceptance", () => ({
  retryFailedCommercialConfirmations: mocks.confirmations,
}));

import { GET, maxDuration } from "./route";

describe("alert notifications cron route", () => {
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
    return GET(new Request("https://example.test/api/cron/alert-notifications"));
  }

  it("passe par la supervision, sous son nom, avec un rattrapage une heure après l'évaluation", async () => {
    mocks.dispatch.mockResolvedValueOnce({ emailCandidateCount: 0 });
    mocks.confirmations.mockResolvedValueOnce({ sentCount: 0 });
    await runHandler();
    const [, jobName, , options] = mocks.runMonitoredCron.mock.calls[0];
    expect(jobName).toBe("alert-notifications");
    // `smart-alerts` : 08:15 ; l'envoi : 09:30 (voir vercel.json).
    expect(options).toEqual({ catchUpSchedule: "30 9 * * *" });
  });

  it("déclare une durée maximale", () => {
    expect(maxDuration).toBe(300);
  });

  it("vérifie les envois d'e-mails après avoir tout envoyé, puis rend le rapport", async () => {
    const alerts = { emailCandidateCount: 3, emailFailedCount: 0 };
    mocks.dispatch.mockResolvedValueOnce(alerts);
    mocks.confirmations.mockResolvedValueOnce({ sentCount: 1 });
    const response = await runHandler();
    expect(mocks.assertComplete).toHaveBeenCalledWith(alerts);
    expect(await response.json()).toMatchObject({
      emailCandidateCount: 3,
      commercialConfirmations: { sentCount: 1 },
    });
  });

  it("fait échouer le passage quand la vérification refuse (e-mails non partis)", async () => {
    mocks.dispatch.mockResolvedValueOnce({ emailCandidateCount: 3 });
    mocks.confirmations.mockResolvedValueOnce({});
    mocks.assertComplete.mockImplementationOnce(() => {
      throw new Error(
        "Alertes e-mail : 3 envoi(s) dû(s) mais l'envoi d'e-mails n'est pas configuré.",
      );
    });
    await expect(runHandler()).rejects.toThrow("n'est pas configuré");
    // Les confirmations commerciales ont été tentées avant : rien n'est perdu par l'échec.
    expect(mocks.confirmations).toHaveBeenCalledTimes(1);
  });
});
