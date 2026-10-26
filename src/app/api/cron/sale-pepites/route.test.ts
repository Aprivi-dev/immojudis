import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSalePepitesBatch: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", async () => ({
  positiveNumberFromEnv: (
    await vi.importActual<typeof import("@/lib/cron-jobs")>("@/lib/cron-jobs")
  ).positiveNumberFromEnv,
  runMonitoredCron: mocks.runMonitoredCron,
}));
vi.mock("@/lib/sale-pepites-batch", () => ({
  runSalePepitesBatch: mocks.runSalePepitesBatch,
}));

import { GET, maxDuration } from "./route";

describe("sale pepites cron route", () => {
  afterEach(() => {
    mocks.runSalePepitesBatch.mockReset();
    mocks.runMonitoredCron.mockReset();
    delete process.env.SALE_PEPITES_BATCH_LIMIT;
  });

  function runHandler() {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );
    return GET(new Request("https://example.test/api/cron/sale-pepites"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.runSalePepitesBatch.mockResolvedValueOnce({ evaluated: 3 });

    const response = await runHandler();

    expect(await response.json()).toEqual({ evaluated: 3 });
    expect(mocks.runMonitoredCron).toHaveBeenCalledTimes(1);
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("sale-pepites");
    expect(mocks.runSalePepitesBatch).toHaveBeenCalledWith({ limit: 300 });
  });

  it("ne diffère aucune reprise : elle ajouterait du temps à une route bornée par maxDuration", async () => {
    mocks.runSalePepitesBatch.mockResolvedValueOnce({});

    await runHandler();

    expect(mocks.runMonitoredCron.mock.calls[0][3]).toEqual({ retryDelaysMs: [] });
  });

  it("lit la taille du lot dans l'environnement", async () => {
    process.env.SALE_PEPITES_BATCH_LIMIT = "120";
    mocks.runSalePepitesBatch.mockResolvedValueOnce({});

    await runHandler();

    expect(mocks.runSalePepitesBatch).toHaveBeenCalledWith({ limit: 120 });
  });

  it("laisse cinq minutes à l'exécution", () => {
    expect(maxDuration).toBe(300);
  });
});
