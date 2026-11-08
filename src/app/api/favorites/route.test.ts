import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

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
// Même base en mémoire pour le client du compte et le rôle de service (événements d'usage). Elle
// n'applique aucune RLS : seul le filtre `user_id` du code écarte les favoris d'un autre compte.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));

import { DELETE, GET, POST } from "./route";

const SALE_OWN = "0b6f2d5e-1c3a-4e8b-9f7d-2a4c6e8b0d11";
const SALE_OTHER = "5c9e1a3b-7d2f-4b6a-8e0c-3f5a7b9d1e22";
const SALE_SHARED = "9a1b3c5d-7e9f-4a2b-8c4d-6e8f0a2b4c33";
const url = "https://immojudis.test/api/favorites";

function call(
  handler: (request: Request) => Promise<Response>,
  method: "GET" | "POST" | "DELETE",
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

function favorite(userId: string, saleId: string) {
  return {
    id: `${userId}-${saleId}`,
    user_id: userId,
    sale_id: saleId,
    created_at: "2026-11-01T10:00:00.000Z",
    personal_status: "watching",
    bid_ceiling_eur: userId === "user-2" ? 123_456 : null,
    bid_ceiling_saved_at: null,
  };
}

function sale(id: string) {
  return { id, title: `Vente ${id}`, department: "33", starting_price_eur: 100_000 };
}

describe("/api/favorites", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      user_favorites: [
        favorite("user-1", SALE_OWN),
        favorite("user-1", SALE_SHARED),
        favorite("user-2", SALE_OTHER),
        favorite("user-2", SALE_SHARED),
      ],
      v_auction_sales_app: [sale(SALE_OWN), sale(SALE_OTHER), sale(SALE_SHARED)],
    });
    // Compte premium : offre Analyse sans lecture d'abonnement.
    mocks.requireAuth.mockResolvedValue({
      userId: "user-1",
      supabase: mocks.db.client,
      claims: { sub: "user-1" },
      accountTier: "premium",
      userRole: "user",
      isAdmin: false,
    });
  });

  it("answers 401 without a token on every method, before any query", async () => {
    for (const response of [
      await call(GET, "GET", { token: false }),
      await call(POST, "POST", { body: { saleId: SALE_OWN }, token: false }),
      await call(DELETE, "DELETE", { query: `?saleId=${SALE_OWN}`, token: false }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on an empty, malformed or invalid POST body, without writing", async () => {
    for (const body of ["", "{bad json", {}, { saleId: "pas-un-uuid" }]) {
      const response = await call(POST, "POST", { body });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on a DELETE without saleId or with an invalid one, without deleting", async () => {
    for (const query of ["", "?saleId=", "?saleId=pas-un-uuid"]) {
      const response = await call(DELETE, "DELETE", { query });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
    expect(mocks.db.rows("user_favorites")).toHaveLength(4);
  });

  it("lists only the favorites of the signed-in account", async () => {
    const response = await call(GET, "GET");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.favorites.map((item: { saleId: string }) => item.saleId).sort()).toEqual(
      [SALE_OWN, SALE_SHARED].sort(),
    );
    expect(body.unavailableSaleIds).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("123456");
  });

  it("adds the favorite to the token's account, never to an account named in the body", async () => {
    const response = await call(POST, "POST", {
      body: { saleId: SALE_OTHER, userId: "user-2", user_id: "user-2" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ created: true, favorite: { saleId: SALE_OTHER } });
    expect(mocks.db.rows("user_favorites", { sale_id: SALE_OTHER })).toEqual([
      expect.objectContaining({ user_id: "user-2" }),
      expect.objectContaining({ user_id: "user-1" }),
    ]);
  });

  it("removes only the account's own favorite and leaves the other account's row intact", async () => {
    const response = await call(DELETE, "DELETE", { query: `?saleId=${SALE_SHARED}` });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ ok: true, removed: true });
    expect(mocks.db.rows("user_favorites", { sale_id: SALE_SHARED })).toEqual([
      expect.objectContaining({ user_id: "user-2", bid_ceiling_eur: 123_456 }),
    ]);
  });

  it("does not delete or reveal a favorite that belongs only to another account", async () => {
    const response = await call(DELETE, "DELETE", { query: `?saleId=${SALE_OTHER}` });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ removed: false, dossier: null });
    expect(mocks.db.rows("user_favorites", { user_id: "user-2" })).toHaveLength(2);
  });
});
