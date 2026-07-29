import { afterEach, describe, expect, it, vi } from "vitest";
import { operationalErrorMessage, runMonitoredCron } from "@/lib/cron-jobs";

describe("operational cron errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CRON_SECRET;
  });

  it("preserves structured PostgREST errors for operators", () => {
    expect(
      operationalErrorMessage({
        message: "permission denied for table user_profiles",
        details: "service_role cannot select rows",
        hint: null,
        code: "42501",
      }),
    ).toBe("permission denied for table user_profiles · service_role cannot select rows · 42501");
  });

  it("keeps a safe fallback for opaque failures", () => {
    expect(operationalErrorMessage({ unexpected: true })).toBe("Scheduled job failed");
  });

  it("rejects unauthorized calls with a safe request id and a structured log", async () => {
    process.env.CRON_SECRET = "cron-test-secret";
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();

    const response = await runMonitoredCron(
      new Request("https://example.test/api/cron/test", {
        headers: { "x-request-id": "unsafe request id" },
      }),
      "test-job",
      handler,
    );
    const body = await response.json();
    const log = JSON.parse(String(warningLog.mock.calls[0]?.[0]));

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.requestId).not.toContain("unsafe request id");
    expect(log).toMatchObject({
      scope: "cron",
      requestId: body.requestId,
      jobName: "test-job",
      status: 401,
      outcome: "unauthorized",
    });
    expect(log.durationMs).toEqual(expect.any(Number));
  });
});
