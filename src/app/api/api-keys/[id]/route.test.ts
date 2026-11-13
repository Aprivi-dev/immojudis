import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, PublicApiError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), revoke: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    if (!request.headers.get("authorization")) {
      throw new AuthRequiredError("Unauthorized: No authorization header provided");
    }
    return "token";
  },
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/api-keys", () => ({ revokeUserApiKey: mocks.revoke }));

import { DELETE } from "./route";

const KEY_ID = "11111111-1111-4111-8111-111111111111";
const call = (id = KEY_ID, withToken = true) =>
  DELETE(
    new Request(`https://immojudis.test/api/api-keys/${id}`, {
      method: "DELETE",
      headers: withToken ? { authorization: "Bearer token" } : undefined,
    }),
    { params: Promise.resolve({ id }) },
  );

describe("DELETE /api/api-keys/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.revoke.mockResolvedValue({ key: { id: KEY_ID, revokedAt: "2026-10-31T10:00:00.000Z" } });
  });

  it("answers 401 without a token and does not touch the key", async () => {
    expect((await call(KEY_ID, false)).status).toBe(401);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed identifier", async () => {
    mocks.revoke.mockRejectedValue(new PublicApiError("Identifiant de clé invalide.", 400));

    const response = await call("not-a-uuid");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_REQUEST",
      error: "Identifiant de clé invalide.",
    });
  });

  it("answers 404 for an unknown key", async () => {
    mocks.revoke.mockRejectedValue(new PublicApiError("Clé API introuvable.", 404));

    const response = await call();

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 500, not 404, on a database failure", async () => {
    mocks.revoke.mockRejectedValue(new Error("connection reset by peer"));

    expect((await call()).status).toBe(500);
  });

  it("revokes a key of the account", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.revoke).toHaveBeenCalledWith({ auth: { userId: "user-1" }, keyId: KEY_ID });
  });
});
