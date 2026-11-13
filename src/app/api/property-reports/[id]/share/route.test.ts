import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), enable: vi.fn(), disable: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    if (!request.headers.get("authorization")) {
      throw new AuthRequiredError("Unauthorized: No authorization header provided");
    }
    return "token";
  },
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/lib/property-reports", () => ({
  enablePropertyReportShare: mocks.enable,
  disablePropertyReportShare: mocks.disable,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "report-1" }) };
const post = (body?: string, withToken = true) =>
  POST(
    new Request("https://immojudis.test/api/property-reports/report-1/share", {
      method: "POST",
      headers: withToken ? { authorization: "Bearer token" } : undefined,
      body,
    }),
    params,
  );

describe("POST /api/property-reports/[id]/share", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({ userId: "user-1" });
    mocks.enable.mockResolvedValue({ share: { enabled: true } });
  });

  it("answers 401 without a token, whatever the body", async () => {
    expect((await post("{bad", false)).status).toBe(401);
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("answers 400 for a null, malformed or wrongly typed body, without enabling the share", async () => {
    for (const body of ["null", "{pas du json", "[]", '"texte"', '{"expiresAt":42}']) {
      const response = await post(body);
      expect(response.status, body).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("uses the default duration when the body is absent, empty or has no date", async () => {
    for (const body of [undefined, "  ", "{}", '{"expiresAt":null}']) {
      expect((await post(body)).status, String(body)).toBe(200);
    }
    expect(mocks.enable).toHaveBeenCalledTimes(4);
    expect(mocks.enable).toHaveBeenLastCalledWith(
      expect.objectContaining({ reportId: "report-1", expiresAt: null }),
    );
  });

  it("passes a requested expiry date", async () => {
    await post(JSON.stringify({ expiresAt: "2026-12-01T00:00:00.000Z" }));

    expect(mocks.enable).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: "2026-12-01T00:00:00.000Z" }),
    );
  });

  it("answers 400 with the business message for an invalid or too distant date", async () => {
    mocks.enable.mockRejectedValue(new Error("La durée maximale d'un partage est de 90 jours."));

    const response = await post(JSON.stringify({ expiresAt: "2030-01-01T00:00:00.000Z" }));

    expect(response.status).toBe(400);
  });
});
