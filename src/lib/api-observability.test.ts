import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, createApiRequestContext } from "./api-observability";

describe("API observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves a safe caller request id", () => {
    const context = createApiRequestContext(
      new Request("https://example.test/api", { headers: { "x-request-id": "edge-12345678" } }),
      "api.test",
    );

    expect(context.requestId).toBe("edge-12345678");
  });

  it("replaces unsafe request ids and redacts internal errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = createApiRequestContext(
      new Request("https://example.test/api", { headers: { "x-request-id": "bad id value" } }),
      "api.test",
    );

    const response = apiError(new Error("database password=secret"), context, {
      fallbackMessage: "Service indisponible.",
    });
    const body = await response.json();

    expect(context.requestId).not.toContain("bad id");
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe(context.requestId);
    expect(body).toMatchObject({
      ok: false,
      code: "INTERNAL_ERROR",
      error: "Service indisponible.",
      requestId: context.requestId,
    });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("returns a stable code and retry hint for rate limits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const context = createApiRequestContext(new Request("https://example.test/api"), "api.test");
    const response = apiError(new Error("Trop de demandes pour cet export"), context, {
      fallbackMessage: "Export impossible.",
      headers: { "retry-after": "60" },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
  });
});
