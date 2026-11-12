import { describe, expect, it } from "vitest";
import { GET, PATCH, POST } from "./route";

describe("end-user information-agent route", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
    ["PATCH", PATCH],
  ])("returns 410 for %s because the workflow is admin-only", async (method, handler) => {
    const response = await handler(
      new Request("https://example.test/api/information-agent", { method }),
    );

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Cette fonctionnalité est désormais réservée à l’administration.",
      code: "INVALID_REQUEST",
    });
  });
});
