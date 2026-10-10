import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const report = JSON.stringify({
  "csp-report": {
    "document-uri": "https://immojudis.com/",
    "effective-directive": "script-src-elem",
    "blocked-uri": "inline",
  },
});

describe("POST /api/csp-report", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a compact summary and answers 204 without echoing anything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await POST(
      new Request("https://immojudis.com/api/csp-report", { method: "POST", body: report }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      scope: "csp-report",
      directive: "script-src-elem",
    });
  });

  it("rejects oversized reports", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await POST(
      new Request("https://immojudis.com/api/csp-report", {
        method: "POST",
        body: "x".repeat(20_000),
      }),
    );

    expect(response.status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });
});
