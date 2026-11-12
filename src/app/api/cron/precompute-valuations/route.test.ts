import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runBatch: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/sale-market-estimates", () => ({
  runSaleValuationPrecomputeBatch: mocks.runBatch,
}));

import { GET, maxDuration } from "./route";

describe("precompute valuations cron route", () => {
  afterEach(() => {
    mocks.runBatch.mockReset();
    mocks.runMonitoredCron.mockReset();
    vi.unstubAllEnvs();
  });

  function runHandler() {
    mocks.runMonitoredCron.mockImplementationOnce(
      async (_request: Request, _jobName: string, handler: () => Promise<unknown>) =>
        Response.json(await handler()),
    );
    return GET(new Request("https://example.test/api/cron/precompute-valuations"));
  }

  it("passe par la supervision, sans taille de lot imposée : la bibliothèque applique la sienne", async () => {
    mocks.runBatch.mockResolvedValueOnce({ processed: 0 });

    await runHandler();

    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("precompute-valuations");
    expect(mocks.runBatch).toHaveBeenCalledWith({ limit: undefined });
  });

  it("lit la taille du lot dans l'environnement", async () => {
    vi.stubEnv("VALUATION_PRECOMPUTE_BATCH_LIMIT", "40");
    mocks.runBatch.mockResolvedValueOnce({});

    await runHandler();

    expect(mocks.runBatch).toHaveBeenCalledWith({ limit: 40 });
  });

  it("laisse cinq minutes à l'exécution", () => {
    expect(maxDuration).toBe(300);
  });
});
