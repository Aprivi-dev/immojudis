import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runListingCompletenessBatch: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", async () => ({
  positiveNumberFromEnv: (
    await vi.importActual<typeof import("@/lib/cron-jobs")>("@/lib/cron-jobs")
  ).positiveNumberFromEnv,
  runMonitoredCron: mocks.runMonitoredCron,
}));
vi.mock("@/lib/listing-completeness-batch", () => ({
  runListingCompletenessBatch: mocks.runListingCompletenessBatch,
}));

import { GET, maxDuration } from "./route";

describe("listing completeness cron route", () => {
  afterEach(() => {
    mocks.runListingCompletenessBatch.mockReset();
    mocks.runMonitoredCron.mockReset();
    delete process.env.LISTING_COMPLETENESS_BATCH_LIMIT;
  });

  function runHandler() {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => Response.json(await handler()),
    );
    return GET(new Request("https://example.test/api/cron/listing-completeness"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche", async () => {
    mocks.runListingCompletenessBatch.mockResolvedValueOnce({ evaluated: 3 });

    const response = await runHandler();

    expect(await response.json()).toEqual({ evaluated: 3 });
    expect(mocks.runMonitoredCron).toHaveBeenCalledTimes(1);
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("listing-completeness");
    expect(mocks.runListingCompletenessBatch).toHaveBeenCalledWith({ limit: 300 });
  });

  it("fait du passage quotidien de vercel.json un filet, sans effet si pg_cron a réussi dans les 2 h", async () => {
    mocks.runListingCompletenessBatch.mockResolvedValueOnce({});

    await runHandler();

    expect(mocks.runMonitoredCron.mock.calls[0][3]).toEqual({
      catchUpSchedule: "50 5 * * *",
      catchUpSuccessWindowHours: 2,
    });
  });

  it("lit la taille du lot dans l'environnement", async () => {
    process.env.LISTING_COMPLETENESS_BATCH_LIMIT = "120";
    mocks.runListingCompletenessBatch.mockResolvedValueOnce({});

    await runHandler();

    expect(mocks.runListingCompletenessBatch).toHaveBeenCalledWith({ limit: 120 });
  });

  it("laisse cinq minutes à l'exécution", () => {
    expect(maxDuration).toBe(300);
  });
});
