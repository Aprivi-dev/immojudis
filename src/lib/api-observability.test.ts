import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_CODES, RateLimitError } from "./api-errors";
import { apiError, apiJson, createApiRequestContext } from "./api-observability";

describe("API observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists in openapi.yaml exactly the error codes the API can return", () => {
    const contract = readFileSync(join(process.cwd(), "openapi.yaml"), "utf8");
    const schema = contract.slice(contract.indexOf("\n    ApiError:"));
    const enumBlock = /\n {8}code:\s*\n {10}type: string\s*\n {10}enum:\n((?: {12}- .+\n)+)/.exec(
      schema,
    );
    const documented = [...(enumBlock?.[1] ?? "").matchAll(/- (\S+)/g)].map((match) => match[1]);

    expect(documented.length).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it("preserves a safe caller request id", () => {
    const context = createApiRequestContext(
      new Request("https://example.test/api", { headers: { "x-request-id": "edge-12345678" } }),
      "api.test",
    );

    expect(context.requestId).toBe("edge-12345678");
  });

  it("echoes the request id by default and omits it on request (shared public responses)", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const context = createApiRequestContext(
      new Request("https://example.test/api", { headers: { "x-request-id": "edge-12345678" } }),
      "api.test",
    );

    const echoed = apiJson({ ok: true }, context);
    const omitted = apiJson(
      { ok: true },
      createApiRequestContext(new Request("https://example.test/api"), "api.test"),
      { headers: { "cache-control": "public, s-maxage=60" } },
      { echoRequestId: false },
    );

    expect(echoed.headers.get("x-request-id")).toBe("edge-12345678");
    expect(omitted.headers.get("x-request-id")).toBeNull();
    // Le reste ne change pas : l'en-tête de cache demandé est conservé.
    expect(omitted.headers.get("cache-control")).toBe("public, s-maxage=60");
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
    const response = apiError(new RateLimitError("Trop de demandes pour cet export"), context, {
      fallbackMessage: "Export impossible.",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
  });
});
