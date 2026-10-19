import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSaleReminders: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
  createStore: vi.fn(() => ({ fake: "store" })),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/sale-reminders", () => ({
  runSaleReminders: mocks.runSaleReminders,
  assertSaleRemindersComplete: mocks.assertComplete,
}));
vi.mock("@/lib/sale-reminders-store", () => ({
  createSupabaseSaleReminderStore: mocks.createStore,
}));

import { GET, maxDuration } from "./route";

describe("sale reminders cron route", () => {
  afterEach(() => {
    mocks.runSaleReminders.mockReset();
    mocks.runMonitoredCron.mockReset();
    mocks.assertComplete.mockReset();
  });

  function runHandler(schedule?: string) {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );
    return GET(
      new Request("https://example.test/api/cron/sale-reminders", {
        headers: schedule ? { "x-vercel-cron-schedule": schedule } : {},
      }),
    );
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche, avec son rattrapage", async () => {
    mocks.runSaleReminders.mockResolvedValueOnce({ mode: "off", skipped: "off" });
    const response = await runHandler();
    expect(await response.json()).toEqual({ mode: "off", skipped: "off" });
    expect(mocks.runMonitoredCron).toHaveBeenCalledTimes(1);
    const [, jobName, , options] = mocks.runMonitoredCron.mock.calls[0];
    expect(jobName).toBe("sale-reminders");
    // Le second passage de vercel.json (09:15) ne refait rien si le premier a réussi.
    expect(options).toEqual({ catchUpSchedule: "15 9 * * *" });
  });

  it("lance le passage avec le magasin réel", async () => {
    mocks.runSaleReminders.mockResolvedValueOnce({ mode: "on" });
    await runHandler();
    expect(mocks.runSaleReminders).toHaveBeenCalledWith({
      store: { fake: "store" },
      catchUp: false,
    });
  });

  it("signale le rattrapage de 09:15 au passage", async () => {
    mocks.runSaleReminders.mockResolvedValueOnce({ mode: "on" });
    await runHandler("15 9 * * *");
    expect(mocks.runSaleReminders).toHaveBeenCalledWith({
      store: { fake: "store" },
      catchUp: true,
    });
  });

  it("fait échouer la tâche quand le passage est incomplet (le rattrapage et la supervision jouent)", async () => {
    mocks.runSaleReminders.mockResolvedValueOnce({ mode: "on", emailsFailed: 1 });
    mocks.assertComplete.mockImplementationOnce(() => {
      throw new Error("Rappels d'audience incomplets");
    });
    await expect(runHandler()).rejects.toThrow("incomplets");
  });

  it("déclare une durée maximale littérale compatible avec le budget du passage", () => {
    expect(maxDuration).toBe(60);
  });
});
