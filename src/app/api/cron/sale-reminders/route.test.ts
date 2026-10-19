import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSaleReminders: vi.fn(),
  runMonitoredCron: vi.fn(),
  createStore: vi.fn(() => ({ fake: "store" })),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/sale-reminders", () => ({ runSaleReminders: mocks.runSaleReminders }));
vi.mock("@/lib/sale-reminders-store", () => ({
  createSupabaseSaleReminderStore: mocks.createStore,
}));

import { GET, maxDuration } from "./route";

describe("sale reminders cron route", () => {
  afterEach(() => {
    mocks.runSaleReminders.mockReset();
    mocks.runMonitoredCron.mockReset();
  });

  function runHandler() {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );
    return GET(new Request("https://example.test/api/cron/sale-reminders"));
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
    expect(mocks.runSaleReminders).toHaveBeenCalledWith({ store: { fake: "store" } });
  });

  it("déclare une durée maximale littérale compatible avec le budget du passage", () => {
    expect(maxDuration).toBe(60);
  });
});
