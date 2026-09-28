import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  runMonitoredCron: vi.fn(),
  runInformationAgentInboundQueue: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({
  runMonitoredCron: mocks.runMonitoredCron,
}));
vi.mock("@/lib/information-agent-inbound", () => ({
  runInformationAgentInboundQueue: mocks.runInformationAgentInboundQueue,
}));

describe("information-agent inbound queue cron", () => {
  it("runs the bounded durable queue under the monitored cron guard", async () => {
    mocks.runInformationAgentInboundQueue.mockResolvedValueOnce({
      claimed: 2,
      completed: 2,
      reviewed: 0,
      ignored: 0,
      failed: 0,
    });
    mocks.runMonitoredCron.mockImplementationOnce(
      async (_request: Request, jobName: string, handler: () => Promise<unknown>) =>
        NextResponse.json({ jobName, result: await handler() }),
    );

    const response = await GET(new Request("https://example.test/cron"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jobName: "information-agent-inbound",
      result: {
        claimed: 2,
        completed: 2,
        reviewed: 0,
        ignored: 0,
        failed: 0,
      },
    });
    expect(mocks.runInformationAgentInboundQueue).toHaveBeenCalledWith({ limit: 5 });
  });
});
