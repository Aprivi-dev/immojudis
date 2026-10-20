import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runWeeklyDigest: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
  createStore: vi.fn(() => ({ fake: "store" })),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/weekly-digest", () => ({
  runWeeklyDigest: mocks.runWeeklyDigest,
  assertWeeklyDigestComplete: mocks.assertComplete,
}));
vi.mock("@/lib/weekly-digest-store", () => ({
  createSupabaseWeeklyDigestStore: mocks.createStore,
}));

import { GET, maxDuration } from "./route";

describe("weekly digest cron route", () => {
  afterEach(() => {
    mocks.runWeeklyDigest.mockReset();
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
    return GET(new Request("https://example.test/api/cron/weekly-digest"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.runWeeklyDigest.mockResolvedValueOnce({ mode: "off", skipped: "off" });
    const response = await runHandler();
    expect(await response.json()).toEqual({ mode: "off", skipped: "off" });
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("weekly-digest");
  });

  it("lance le passage avec le magasin réel et vérifie qu'il est complet", async () => {
    mocks.runWeeklyDigest.mockResolvedValueOnce({ mode: "on", emailsSent: 1 });
    await runHandler();
    expect(mocks.runWeeklyDigest).toHaveBeenCalledWith({ store: { fake: "store" } });
    expect(mocks.assertComplete).toHaveBeenCalledWith({ mode: "on", emailsSent: 1 });
  });

  it("fait échouer la tâche quand un envoi est dû et ne peut pas partir", async () => {
    mocks.runWeeklyDigest.mockResolvedValueOnce({ mode: "on", due: 1, configured: false });
    mocks.assertComplete.mockImplementationOnce(() => {
      throw new Error("Récapitulatif hebdomadaire : 1 envoi(s) dû(s)");
    });
    await expect(runHandler()).rejects.toThrow("dû");
  });

  it("déclare une durée maximale littérale compatible avec le budget du passage", () => {
    expect(maxDuration).toBe(60);
  });
});
