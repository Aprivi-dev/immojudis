import { describe, expect, it } from "vitest";
import { GET, PATCH, POST } from "./route";

describe("end-user information-agent route", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
    ["PATCH", PATCH],
  ])("returns 410 for %s because the workflow is admin-only", async (_method, handler) => {
    const response = await handler();

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "ADMIN_ONLY", ok: false });
  });
});
