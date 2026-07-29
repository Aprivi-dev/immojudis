import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, apiJson, createApiRequestContext } from "./api-observability";

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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
      scope: "api.test",
      requestId: context.requestId,
      status: 500,
      code: "INTERNAL_ERROR",
      error: "database password=secret",
    });
  });

  it("logs successful responses once with the correlation fields", () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const context = createApiRequestContext(
      new Request("https://example.test/api", { headers: { "x-request-id": "client-12345678" } }),
      "api.test",
    );

    const response = apiJson({ ok: true }, context, { status: 201 });
    const log = JSON.parse(String(infoLog.mock.calls[0]?.[0]));

    expect(response.status).toBe(201);
    expect(infoLog).toHaveBeenCalledTimes(1);
    expect(log).toMatchObject({
      scope: "api.test",
      requestId: "client-12345678",
      status: 201,
    });
    expect(log.timestamp).toEqual(expect.any(String));
    expect(log.durationMs).toEqual(expect.any(Number));
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
