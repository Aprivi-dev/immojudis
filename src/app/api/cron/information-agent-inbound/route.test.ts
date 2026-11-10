import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  runMonitoredCron: vi.fn(),
  runInformationAgentInboundQueue: vi.fn(),
  dispatchPendingInformationAgentEvidence: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({
  runMonitoredCron: mocks.runMonitoredCron,
}));
vi.mock("@/lib/information-agent-inbound", () => ({
  runInformationAgentInboundQueue: mocks.runInformationAgentInboundQueue,
}));
vi.mock("@/lib/information-agent-evidence-dispatch.server", () => ({
  dispatchPendingInformationAgentEvidence: mocks.dispatchPendingInformationAgentEvidence,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runMonitoredCron.mockImplementation(
    async (_request: Request, jobName: string, handler: () => Promise<unknown>) => {
      try {
        return NextResponse.json({ jobName, result: await handler() });
      } catch (error) {
        return NextResponse.json({ jobName, error: (error as Error).message }, { status: 500 });
      }
    },
  );
});

describe("information-agent inbound queue cron", () => {
  it("runs the bounded durable queue under the monitored cron guard", async () => {
    mocks.runInformationAgentInboundQueue.mockResolvedValueOnce({
      claimed: 2,
      completed: 2,
      reviewed: 0,
      ignored: 0,
      failed: 0,
    });
    mocks.dispatchPendingInformationAgentEvidence.mockResolvedValueOnce({
      status: "dispatched",
      workflow: "information-agent-evidence.yml",
      ref: "main",
    });

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
        evidenceDispatch: {
          status: "dispatched",
          workflow: "information-agent-evidence.yml",
          ref: "main",
        },
      },
    });
    expect(mocks.runInformationAgentInboundQueue).toHaveBeenCalledWith({ limit: 5 });
    expect(mocks.dispatchPendingInformationAgentEvidence).toHaveBeenCalledTimes(1);
  });

  it("un échec du déclenchement de l'analyse ne fait pas échouer la passe des réponses", async () => {
    mocks.runInformationAgentInboundQueue.mockResolvedValueOnce({
      claimed: 1,
      completed: 0,
      reviewed: 1,
      ignored: 0,
      failed: 0,
    });
    mocks.dispatchPendingInformationAgentEvidence.mockResolvedValueOnce({
      status: "failed",
      reason: "http_502",
    });

    const response = await GET(new Request("https://example.test/cron"));

    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({
      reviewed: 1,
      failed: 0,
      evidenceDispatch: { status: "failed", reason: "http_502" },
    });
  });

  it("tente le déclenchement même quand un message de la passe a échoué", async () => {
    mocks.runInformationAgentInboundQueue.mockResolvedValueOnce({
      claimed: 1,
      completed: 0,
      reviewed: 0,
      ignored: 0,
      failed: 1,
    });
    mocks.dispatchPendingInformationAgentEvidence.mockResolvedValueOnce({ status: "not_pending" });

    const response = await GET(new Request("https://example.test/cron"));

    expect(response.status).toBe(500);
    expect(mocks.dispatchPendingInformationAgentEvidence).toHaveBeenCalledTimes(1);
  });
});
