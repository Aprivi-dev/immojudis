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
// L'écriture passe par le rôle de service (sans RLS) : `user_id` doit venir du jeton.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));

import { GET, PATCH } from "./route";

const url = "https://immojudis.test/api/notification-preferences";

function call(
  handler: (request: Request) => Promise<Response>,
  method: "GET" | "PATCH",
  options: { body?: unknown; token?: boolean } = {},
) {
  const { body, token = true } = options;
  return handler(
    new Request(url, {
      method,
      headers: token ? { authorization: "Bearer token" } : undefined,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function preferences(userId: string, enabled: boolean): FakeRow {
  return {
    user_id: userId,
    alert_email_enabled: enabled,
    alert_email_consented_at: enabled ? "2026-10-01T10:00:00.000Z" : null,
    alert_email_revoked_at: null,
    consent_source: "settings",
    updated_at: "2026-10-01T10:00:00.000Z",
  };
}

describe("/api/notification-preferences", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      user_notification_preferences: [preferences("user-1", false), preferences("user-2", true)],
    });
    mocks.requireAuth.mockResolvedValue({
      userId: "user-1",
      supabase: mocks.db.client,
      claims: { sub: "user-1" },
      accountTier: "free",
      userRole: "user",
      isAdmin: false,
    });
  });

  it("answers 401 without a token on both methods, before any query", async () => {
    for (const response of [
      await call(GET, "GET", { token: false }),
      await call(PATCH, "PATCH", { body: { alertEmailEnabled: true }, token: false }),
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
      { alertEmailEnabled: "oui" },
      { weeklyDigestWeekday: 9 },
    ]) {
      const response = await call(PATCH, "PATCH", { body });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
  });

  it("reads only the preferences of the signed-in account", async () => {
    const response = await call(GET, "GET");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).preferences).toMatchObject({
      userId: "user-1",
      alertEmailEnabled: false,
      alertEmailConsentedAt: null,
    });
  });

  it("writes the token's account, never an account named in the body", async () => {
    const response = await call(PATCH, "PATCH", {
      body: { alertEmailEnabled: true, userId: "user-2", user_id: "user-2" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).preferences).toMatchObject({
      userId: "user-1",
      alertEmailEnabled: true,
    });
    expect(mocks.db.rows("user_notification_preferences", { user_id: "user-1" })).toEqual([
      expect.objectContaining({ alert_email_enabled: true }),
    ]);
    expect(mocks.db.rows("user_notification_preferences", { user_id: "user-2" })).toEqual([
      preferences("user-2", true),
    ]);
  });

  it("revokes for the token's account without touching another account's consent", async () => {
    mocks.db.tables.user_notification_preferences[0] = preferences("user-1", true);

    const response = await call(PATCH, "PATCH", { body: { alertEmailEnabled: false } });

    expect(response.status).toBe(200);
    expect(mocks.db.rows("user_notification_preferences", { user_id: "user-1" })).toEqual([
      expect.objectContaining({
        alert_email_enabled: false,
        alert_email_revoked_at: expect.any(String),
      }),
    ]);
    expect(mocks.db.rows("user_notification_preferences", { user_id: "user-2" })).toEqual([
      preferences("user-2", true),
    ]);
  });
});
