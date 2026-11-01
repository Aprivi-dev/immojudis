import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  assertComplete: vi.fn(),
  runMonitoredCron: vi.fn(),
}));

vi.mock("@/lib/cron-jobs", () => ({ runMonitoredCron: mocks.runMonitoredCron }));
vi.mock("@/lib/replies-review-digest", () => ({
  runRepliesReviewDigest: mocks.run,
  assertRepliesReviewDigestComplete: mocks.assertComplete,
}));

import { GET, maxDuration } from "./route";

describe("replies review digest cron route", () => {
  afterEach(() => {
    mocks.run.mockReset();
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
    return GET(new Request("https://example.test/api/cron/replies-review-digest"));
  }

  it("passe par la supervision des tâches planifiées, sous le nom de la tâche, sans rattrapage", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "off", replies: 0, unrouted: 0 });
    const response = await runHandler();
    expect(await response.json()).toEqual({ mode: "off", replies: 0, unrouted: 0 });
    expect(mocks.runMonitoredCron.mock.calls[0][1]).toBe("replies-review-digest");
    expect(mocks.runMonitoredCron.mock.calls[0][3]).toBeUndefined();
    expect(maxDuration).toBe(60);
  });

  it("vérifie que le passage est complet", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "on", replies: 1, unrouted: 0, sent: 1 });
    await runHandler();
    expect(mocks.assertComplete).toHaveBeenCalledWith({
      mode: "on",
      replies: 1,
      unrouted: 0,
      sent: 1,
    });
  });

  it("fait échouer la tâche quand le résumé dû n'est pas parti", async () => {
    mocks.run.mockResolvedValueOnce({ mode: "on", replies: 1, unrouted: 0, failed: 1 });
    mocks.assertComplete.mockImplementationOnce(() => {
      throw new Error("Résumé des réponses à relire : 1 envoi(s) en échec sur 1.");
    });
    await expect(runHandler()).rejects.toThrow("en échec");
  });
});
