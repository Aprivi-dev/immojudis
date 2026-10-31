import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    if (!request.headers.get("authorization")) {
      throw new Error("Unauthorized: No authorization header provided");
    }
    return "token";
  },
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-keys")>()),
  listUserApiKeys: mocks.list,
  createUserApiKey: mocks.create,
}));

import { GET, POST } from "./route";

const headers = { authorization: "Bearer token", "content-type": "application/json" };
const get = (withToken = true) =>
  GET(
    new Request("https://immojudis.test/api/api-keys", {
      headers: withToken ? headers : undefined,
    }),
  );
const post = (body: string, withToken = true) =>
  POST(
    new Request("https://immojudis.test/api/api-keys", {
      method: "POST",
      headers: withToken ? headers : { "content-type": "application/json" },
      body,
    }),
  );

describe("/api/api-keys", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
    mocks.list.mockResolvedValue({ keys: [], limit: 3 });
    mocks.create.mockResolvedValue({ key: { id: "k" }, secret: "ij_live_x", limit: 3 });
  });

  it("answers 401 without a token, on both methods, before reading anything", async () => {
    expect((await get(false)).status).toBe(401);
    expect((await post("{bad json", false)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 401 when the token is rejected", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: Invalid token"));

    expect((await get()).status).toBe(401);
  });

  it("answers 403 when the plan does not include API keys", async () => {
    mocks.list.mockRejectedValue(new Error("Clés API réservées à l’offre Analyse."));
    mocks.create.mockRejectedValue(new Error("Clés API réservées à l’offre Analyse."));

    expect((await get()).status).toBe(403);
    expect((await post(JSON.stringify({ name: "Ma clé" }))).status).toBe(403);
  });

  it("answers 400 for an invalid or malformed body", async () => {
    expect((await post(JSON.stringify({ name: "x" }))).status).toBe(400);
    expect((await post(JSON.stringify({}))).status).toBe(400);
    expect((await post("{bad json")).status).toBe(400);
    expect((await post("null")).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After when the daily creation cap is reached", async () => {
    mocks.create.mockRejectedValue(
      new RateLimitError(undefined, 3600, "Limite quotidienne atteinte, réessayez demain."),
    );

    const response = await post(JSON.stringify({ name: "Ma clé" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("creates a key with 201 and no shared cache", async () => {
    const response = await post(JSON.stringify({ name: "Ma clé" }));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ input: { name: "Ma clé" } }),
    );
  });
});
