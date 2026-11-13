import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  db: null as unknown as FakeSupabase,
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    if (!request.headers.get("authorization")) {
      throw new AuthRequiredError("Unauthorized: No authorization header provided");
    }
    return "token";
  },
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));

import { GET, POST } from "./route";

const url = "https://immojudis.test/api/watched-zones";

function call(
  handler: (request: Request) => Promise<Response>,
  method: "GET" | "POST",
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

function zone(userId: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    name: `Zone ${id}`,
    zone_kind: "department",
    department: "33",
    city: null,
    postal_code_prefix: null,
    center_lat: null,
    center_lng: null,
    radius_km: null,
    alert_defaults: {},
    is_active: true,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("/api/watched-zones", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      user_watched_zones: [
        zone("user-1", "zone-own", { name: "Gironde" }),
        zone("user-2", "zone-other", { name: "Landes", department: "40" }),
      ],
    });
    // Compte premium : offre Analyse (25 zones actives) sans lecture d'abonnement.
    mocks.requireAuth.mockResolvedValue({
      userId: "user-1",
      supabase: mocks.db.client,
      claims: { sub: "user-1" },
      accountTier: "premium",
      userRole: "user",
      isAdmin: false,
    });
  });

  it("answers 401 without a token on both methods, before any query", async () => {
    for (const response of [
      await call(GET, "GET", { token: false }),
      await call(POST, "POST", { body: { name: "Gironde", city: "Bordeaux" }, token: false }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on an empty, malformed or invalid body, without writing", async () => {
    for (const body of [
      "",
      "{bad json",
      {},
      { name: "x", city: "Bordeaux" },
      { name: "Gironde", zoneKind: "department" },
    ]) {
      const response = await call(POST, "POST", { body });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
  });

  it("lists only the zones of the signed-in account", async () => {
    const response = await call(GET, "GET", { query: "?includeInactive=true" });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.zones.map((item: { id: string }) => item.id)).toEqual(["zone-own"]);
  });

  it("creates the zone for the token's account even when another account has the same name", async () => {
    const response = await call(POST, "POST", {
      body: { name: "Landes", zoneKind: "department", department: "40", userId: "user-2" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ zone: { user_id: "user-1", name: "Landes" } });
    expect(mocks.db.rows("user_watched_zones", { name: "Landes" })).toEqual([
      expect.objectContaining({ id: "zone-other", user_id: "user-2" }),
      expect.objectContaining({ user_id: "user-1" }),
    ]);
    expect(mocks.db.rows("user_watched_zones", { id: "zone-other" })[0].updated_at).toBe(
      "2026-11-01T10:00:00.000Z",
    );
  });

  it("counts only the account's own active zones toward the plan limit", async () => {
    mocks.db.tables.user_watched_zones.push(
      ...Array.from({ length: 25 }, (_, index) => zone("user-2", `zone-other-${index}`)),
    );

    const response = await call(POST, "POST", {
      body: { name: "Bordeaux", zoneKind: "city", city: "Bordeaux" },
    });

    expect(response.status).toBe(200);
    expect(mocks.db.rows("user_watched_zones", { user_id: "user-1" })).toHaveLength(2);
  });
});
