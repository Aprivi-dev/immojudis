import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchDuePipeline: vi.fn(),
  evaluateOperationalHealth: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({
  evaluateOperationalHealth: mocks.evaluateOperationalHealth,
  runMonitoredCron: mocks.runMonitoredCron,
}));
vi.mock("@/lib/pipeline-dispatch", () => ({
  dispatchDuePipeline: mocks.dispatchDuePipeline,
}));

import { GET } from "./route";

describe("operational health cron route", () => {
  it("still starts pipeline dispatch when health evaluation fails", async () => {
    mocks.evaluateOperationalHealth.mockRejectedValueOnce(new Error("health unavailable"));
    mocks.dispatchDuePipeline.mockResolvedValueOnce({ dispatched: true, runId: "run-1" });
    mocks.runMonitoredCron.mockImplementationOnce(
      async (
        _request: Request,
        _jobName: string,
        handler: () => Promise<Record<string, unknown>>,
      ) => {
        try {
          return Response.json(await handler());
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      },
    );

    const response = await GET(new Request("https://example.test/api/cron/operational-health"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "health unavailable" });
    expect(mocks.evaluateOperationalHealth).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchDuePipeline).toHaveBeenCalledTimes(1);
  });
});
