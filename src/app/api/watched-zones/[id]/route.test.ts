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
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));

import { DELETE, PATCH } from "./route";

const OWN = "1f3e5a7c-9b1d-4f2a-8c3e-5a7b9c1d3e01";
const OTHER = "2a4c6e8f-0b2d-4e4f-9a6b-8c0d2e4f6a02";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

function call(
  handler: Handler,
  method: "PATCH" | "DELETE",
  id: string,
  options: { body?: unknown; token?: boolean } = {},
) {
  const { body, token = true } = options;
  return handler(
    new Request(`https://immojudis.test/api/watched-zones/${id}`, {
      method,
      headers: token ? { authorization: "Bearer token" } : undefined,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function zone(userId: string, id: string, name: string) {
  return {
    id,
    user_id: userId,
    name,
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
  };
}

function alert(userId: string, zoneId: string) {
  return { id: `alert-${userId}`, user_id: userId, watched_zone_id: zoneId, is_active: true };
}

describe("/api/watched-zones/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      user_watched_zones: [zone("user-1", OWN, "Gironde"), zone("user-2", OTHER, "Landes")],
      user_alerts: [alert("user-1", OWN), alert("user-2", OTHER)],
    });
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
      await call(PATCH, "PATCH", OWN, { body: { name: "Bordeaux" }, token: false }),
      await call(DELETE, "DELETE", OWN, { token: false }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on an invalid id or an empty, malformed or invalid body, without writing", async () => {
    const responses = [
      await call(PATCH, "PATCH", "pas-un-uuid", { body: { name: "Bordeaux" } }),
      await call(DELETE, "DELETE", "pas-un-uuid"),
      ...(await Promise.all(
        ["", "{bad json", { name: "x" }, { zoneKind: "planete" }].map((body) =>
          call(PATCH, "PATCH", OWN, { body }),
        ),
      )),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
  });

  it("updates the account's own zone", async () => {
    const response = await call(PATCH, "PATCH", OWN, { body: { name: "Bordeaux Métropole" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ zone: { id: OWN, name: "Bordeaux Métropole" } });
  });

  it("neither reads nor modifies a zone of another account", async () => {
    const response = await call(PATCH, "PATCH", OTHER, { body: { name: "Volée" } });

    expect(response.ok).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("Landes");
    expect(mocks.db.rows("user_watched_zones", { id: OTHER })).toEqual([
      expect.objectContaining({ user_id: "user-2", name: "Landes" }),
    ]);
    expect(mocks.db.queries.filter((query) => query.action === "update")).toEqual([]);
  });

  it("deletes the account's own zone and leaves the other account's zone and alerts alone", async () => {
    // Ligne artificielle : même une alerte d'autrui rattachée à cette zone n'est pas désactivée.
    mocks.db.tables.user_alerts.push({ ...alert("user-3", OWN), id: "alert-user-3" });

    const response = await call(DELETE, "DELETE", OWN);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("user_watched_zones").map((row) => row.id)).toEqual([OTHER]);
    expect(mocks.db.rows("user_alerts", { user_id: "user-1" })).toEqual([
      expect.objectContaining({ watched_zone_id: null, is_active: false }),
    ]);
    expect(mocks.db.rows("user_alerts", { user_id: "user-2" })).toEqual([
      expect.objectContaining({ watched_zone_id: OTHER, is_active: true }),
    ]);
    expect(mocks.db.rows("user_alerts", { user_id: "user-3" })).toEqual([
      expect.objectContaining({ watched_zone_id: OWN, is_active: true }),
    ]);
  });

  it("does not delete a zone of another account nor detach its alerts", async () => {
    const response = await call(DELETE, "DELETE", OTHER);

    expect(response.ok).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("user_watched_zones", { id: OTHER })).toHaveLength(1);
    expect(mocks.db.rows("user_alerts", { user_id: "user-2" })).toEqual([
      expect.objectContaining({ watched_zone_id: OTHER, is_active: true }),
    ]);
  });
});
