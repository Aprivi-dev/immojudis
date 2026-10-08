import { describe, expect, it } from "vitest";
import { adminErrorResponse } from "./api-route-errors";

describe("adminErrorResponse", () => {
  it("preserves authorization statuses and error messages", async () => {
    const unauthorized = adminErrorResponse(new Error("Unauthorized: session required"));
    const forbidden = adminErrorResponse(new Error("Forbidden: admin only"));
    const notFound = adminErrorResponse(new Error("NotFound: item missing"));

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "Unauthorized: session required" });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Forbidden: admin only" });
    expect(notFound.status).toBe(404);
  });

  it("uses the configured fallback for non-error failures", async () => {
    const response = adminErrorResponse(null, {
      fallbackMessage: "Diagnostic indisponible",
      fallbackStatus: 500,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Diagnostic indisponible" });
  });
});
