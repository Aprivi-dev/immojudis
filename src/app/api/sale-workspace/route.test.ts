import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow, type FakeSupabase } from "@/test/fake-supabase";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  db: null as unknown as FakeSupabase,
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
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));

import { GET, PUT } from "./route";

const SALE = "7f9b1d3e-5a7c-4e9f-8b1d-3e5f7a9b1c01";
const SALE_OTHER_ONLY = "8a0c2e4f-6b8d-4f0a-9c2e-4f6a8b0c2d02";
const url = "https://immojudis.test/api/sale-workspace";

function call(
  handler: (request: Request) => Promise<Response>,
  method: "GET" | "PUT",
  options: { body?: unknown; query?: string; token?: boolean } = {},
) {
  const { body, query = "", token = true } = options;
  return handler(
    new Request(`${url}${query}`, {
      method,
      headers: token ? { authorization: "Bearer token" } : undefined,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function workspace(userId: string, saleId: string, general: string): FakeRow {
  return {
    id: `ws-${userId}-${saleId}`,
    user_id: userId,
    sale_id: saleId,
    tracking_status: "watching",
    private_notes: { general },
    checklist: {},
    alert_preferences: {},
    document_reviews: {},
    next_action: null,
    updated_at: "2026-11-01T10:00:00.000Z",
  };
}

function signIn(accountTier: "premium" | "free") {
  mocks.requireAuth.mockResolvedValue({
    userId: "user-1",
    supabase: mocks.db.client,
    claims: { sub: "user-1" },
    accountTier,
    userRole: "user",
    isAdmin: false,
  });
}

describe("/api/sale-workspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      sale_workspaces: [
        workspace("user-1", SALE, "Mes notes"),
        workspace("user-2", SALE, "Notes d'autrui"),
        workspace("user-2", SALE_OTHER_ONLY, "Autre dossier d'autrui"),
      ],
    });
    signIn("premium");
  });

  it("answers 401 without a token on both methods, before any query", async () => {
    for (const response of [
      await call(GET, "GET", { query: `?saleId=${SALE}`, token: false }),
      await call(PUT, "PUT", { body: { saleId: SALE }, token: false }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on a missing saleId or an empty, malformed or invalid body", async () => {
    const responses = [
      await call(GET, "GET"),
      await call(GET, "GET", { query: "?saleId=pas-un-uuid" }),
      ...(await Promise.all(
        ["", "{bad json", {}, { saleId: "pas-un-uuid" }, { saleId: SALE, targetYieldPct: 500 }].map(
          (body) => call(PUT, "PUT", { body }),
        ),
      )),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries.map((query) => query.table)).not.toContain("sale_workspaces");
  });

  it("answers 403 to an account without the tracking space, before reading or writing", async () => {
    signIn("free");

    for (const response of [
      await call(GET, "GET", { query: `?saleId=${SALE}` }),
      await call(PUT, "PUT", { body: { saleId: SALE, nextAction: "Visiter" } }),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries.map((query) => query.table)).not.toContain("sale_workspaces");
  });

  it("reads only the account's own workspace, with private no-store", async () => {
    const own = await call(GET, "GET", { query: `?saleId=${SALE}` });
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
    expect((await own.json()).workspace).toMatchObject({
      user_id: "user-1",
      private_notes: { general: "Mes notes" },
    });

    const foreign = await call(GET, "GET", { query: `?saleId=${SALE_OTHER_ONLY}` });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("cache-control")).toBe("private, no-store");
    expect(await foreign.json()).toEqual({ workspace: null });
  });

  it("writes the token's account only, never an account named in the body", async () => {
    const response = await call(PUT, "PUT", {
      body: { saleId: SALE_OTHER_ONLY, nextAction: "Visiter", userId: "user-2", user_id: "user-2" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).workspace).toMatchObject({
      user_id: "user-1",
      next_action: "Visiter",
    });
    expect(mocks.db.rows("sale_workspaces", { user_id: "user-2" })).toEqual([
      workspace("user-2", SALE, "Notes d'autrui"),
      workspace("user-2", SALE_OTHER_ONLY, "Autre dossier d'autrui"),
    ]);
  });
});
