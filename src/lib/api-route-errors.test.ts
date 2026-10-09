import { afterEach, describe, expect, it, vi } from "vitest";
import { adminErrorResponse } from "./api-route-errors";

describe("adminErrorResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves authorization statuses with generic messages and a request id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unauthorized = adminErrorResponse(new Error("Unauthorized: session required"));
    const forbidden = adminErrorResponse(new Error("Forbidden: admin only"));
    const notFound = adminErrorResponse(new Error("NotFound: item missing"));

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      error: "Authentification requise.",
      code: "AUTH_REQUIRED",
      requestId: expect.any(String),
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("x-request-id")).toEqual(expect.any(String));
    expect(notFound.status).toBe(404);
  });

  it("uses the configured fallback for non-error failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = adminErrorResponse(null, {
      fallbackMessage: "Diagnostic indisponible",
      fallbackStatus: 500,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Diagnostic indisponible" });
  });

  it("keeps database detail in the logs and out of the response", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = adminErrorResponse(
      new Error('duplicate key value violates unique constraint "auction_sales_pkey"'),
      { fallbackMessage: "Erreur admin", fallbackStatus: 500, requestId: "support-12345678" },
    );
    const body = await response.json();

    expect(body).toEqual({
      error: "Erreur admin",
      code: "INTERNAL_ERROR",
      requestId: "support-12345678",
    });
    expect(JSON.stringify(body)).not.toContain("auction_sales_pkey");
    expect(String(errorLog.mock.calls[0]?.[0])).toContain("auction_sales_pkey");
  });
});
