import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSaleResults: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
  createStore: vi.fn(() => ({ fake: "store" })),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/sale-results", () => ({
  runSaleResults: mocks.runSaleResults,
  assertSaleResultsComplete: mocks.assertComplete,
}));
vi.mock("@/lib/sale-results-store", () => ({
  createSupabaseSaleResultStore: mocks.createStore,
}));

import { GET, maxDuration } from "./route";

describe("sale results cron route", () => {
  afterEach(() => {
    mocks.runSaleResults.mockReset();
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
    return GET(new Request("https://example.test/api/cron/sale-results"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.runSaleResults.mockResolvedValueOnce({ mode: "off", skipped: "off" });
    const response = await runHandler();
    expect(await response.json()).toEqual({ mode: "off", skipped: "off" });
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("sale-results");
  });

  it("lance le passage avec le magasin réel et vérifie qu'il est complet", async () => {
    mocks.runSaleResults.mockResolvedValueOnce({ mode: "on", emailsSent: 1 });
    await runHandler();
    expect(mocks.runSaleResults).toHaveBeenCalledWith({ store: { fake: "store" } });
    expect(mocks.assertComplete).toHaveBeenCalledWith({ mode: "on", emailsSent: 1 });
  });

  it("fait échouer la tâche quand le passage est incomplet", async () => {
    mocks.runSaleResults.mockResolvedValueOnce({ mode: "on", emailsFailed: 1 });
    mocks.assertComplete.mockImplementationOnce(() => {
      throw new Error("Alertes de résultat incomplètes");
    });
    await expect(runHandler()).rejects.toThrow("incomplètes");
  });

  it("déclare une durée maximale littérale compatible avec le budget du passage", () => {
    expect(maxDuration).toBe(60);
  });
});
