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

import { PUT } from "./route";

const SALE = "9b1d3f5a-7c9e-4a1b-8d3f-5a7c9e1b3d01";
const SALE_NEW = "0c2e4a6b-8d0f-4b2c-9e4a-6b8d0f2c4e02";
const REVISION = "2026-11-01T10:00:00.000Z";
const draft = { kind: "tribunal", priceEur: 120_000 };

function put(body: unknown, token = true) {
  return PUT(
    new Request("https://immojudis.test/api/sale-workspace/professional-pilot", {
      method: "PUT",
      headers: token ? { authorization: "Bearer token" } : undefined,
      body: typeof body === "string" ? body : JSON.stringify(body),
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
    // Même révision pour les deux comptes : seul le filtre `user_id` les distingue.
    updated_at: REVISION,
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

describe("PUT /api/sale-workspace/professional-pilot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      sale_workspaces: [
        workspace("user-1", SALE, "Mes notes"),
        workspace("user-2", SALE, "Notes d'autrui"),
        workspace("user-2", SALE_NEW, "Dossier d'autrui"),
      ],
    });
    signIn("premium");
  });

  it("answers 401 without a token, before any query", async () => {
    const response = await put({ saleId: SALE, expectedUpdatedAt: REVISION, draft }, false);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on an empty, malformed or invalid body, without touching the workspaces", async () => {
    for (const body of [
      "",
      "{bad json",
      {},
      { saleId: "pas-un-uuid", expectedUpdatedAt: null, draft },
      { saleId: SALE, expectedUpdatedAt: REVISION, draft: { kind: "inconnu" } },
    ]) {
      const response = await put(body);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries.map((query) => query.table)).not.toContain("sale_workspaces");
  });

  it("answers 403 to an account without the tracking space, before reading or writing", async () => {
    signIn("free");

    const response = await put({ saleId: SALE, expectedUpdatedAt: REVISION, draft });

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.queries.map((query) => query.table)).not.toContain("sale_workspaces");
  });

  it("updates the account's own workspace only, with private no-store", async () => {
    const response = await put({ saleId: SALE, expectedUpdatedAt: REVISION, draft });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).workspace).toMatchObject({
      user_id: "user-1",
      private_notes: { general: "Mes notes", professionalDossier: { kind: "tribunal" } },
    });
    expect(mocks.db.rows("sale_workspaces", { user_id: "user-2", sale_id: SALE })).toEqual([
      workspace("user-2", SALE, "Notes d'autrui"),
    ]);
  });

  it("creates the account's own workspace when only another account has one for this sale", async () => {
    const response = await put({ saleId: SALE_NEW, expectedUpdatedAt: null, draft });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("sale_workspaces", { sale_id: SALE_NEW })).toEqual([
      workspace("user-2", SALE_NEW, "Dossier d'autrui"),
      expect.objectContaining({ user_id: "user-1" }),
    ]);
  });
});
