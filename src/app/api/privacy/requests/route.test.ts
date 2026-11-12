import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, RateLimitError } from "@/lib/api-errors";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforceUser: vi.fn(),
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
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforceUser }));
// Les demandes sont lues et écrites avec le rôle de service (sans RLS) : seul le filtre du code
// sépare les comptes. La base en mémoire applique vraiment les filtres.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));
vi.mock("@/lib/billing", () => ({ getStripe: vi.fn() }));

import { GET, POST } from "./route";

const url = "https://immojudis.test/api/privacy/requests";

function request(method: "GET" | "POST", body?: unknown, withToken = true) {
  return new Request(url, {
    method,
    headers: withToken ? { authorization: "Bearer token" } : undefined,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function demand(userId: string, id: string, status = "received") {
  return {
    id,
    user_id: userId,
    requester_email: `${userId}@exemple.test`,
    request_type: "access",
    status,
    identity_status: "authenticated",
    message: `Message de ${userId}`,
    submitted_at: "2026-11-01T10:00:00.000Z",
    acknowledged_at: null,
    due_at: "2026-12-01T10:00:00.000Z",
    completed_at: null,
    resolution_code: null,
    operator_notes: "note interne",
    metadata: {},
  };
}

// Valeurs par défaut de `data_subject_requests` (migration) dont la réponse a besoin.
const DEFAULTS = {
  data_subject_requests: {
    status: "received",
    identity_status: "authenticated",
    submitted_at: "2026-11-08T10:00:00.000Z",
  },
};

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/);
}

describe("/api/privacy/requests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase(
      { data_subject_requests: [demand("user-1", "req-own"), demand("user-2", "req-other")] },
      { defaults: DEFAULTS },
    );
    mocks.requireAuth.mockResolvedValue({
      userId: "user-1",
      supabase: mocks.db.client,
      claims: { sub: "user-1", email: "user-1@exemple.test" },
      isAdmin: false,
    });
    mocks.enforceUser.mockResolvedValue(1);
  });

  it("answers 401 without a token on both methods, before any read or write", async () => {
    for (const response of [
      await GET(request("GET", undefined, false)),
      await POST(request("POST", { requestType: "access" }, false)),
    ]) {
      expect(response.status).toBe(401);
      expectNoStore(response);
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.enforceUser).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 401 when the token is rejected", async () => {
    mocks.requireAuth.mockRejectedValue(new AuthRequiredError("Unauthorized: Invalid token"));

    expect((await GET(request("GET"))).status).toBe(401);
    expect((await POST(request("POST", { requestType: "access" }))).status).toBe(401);
    expect(mocks.db.queries).toEqual([]);
  });

  it("lists only the requests of the signed-in account, without internal columns", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expectNoStore(response);
    const body = await response.json();
    expect(body.requests.map((item: { id: string }) => item.id)).toEqual(["req-own"]);
    expect(JSON.stringify(body)).not.toContain("user-2");
    expect(JSON.stringify(body)).not.toContain("note interne");
    expect(mocks.db.queries[0].filters).toContainEqual({
      op: "eq",
      column: "user_id",
      value: "user-1",
    });
  });

  it("answers 400 on an empty, malformed or invalid body, without writing", async () => {
    for (const body of ["", "{bad json", {}, { requestType: "inconnu" }]) {
      const response = await POST(request("POST", body));
      expect(response.status).toBe(400);
      expectNoStore(response);
    }
    expect(mocks.db.queries).toEqual([]);
    expect(mocks.db.rows("data_subject_requests")).toHaveLength(2);
  });

  it("answers 429 when the account exceeds its form quota, before writing", async () => {
    mocks.enforceUser.mockRejectedValue(new RateLimitError(undefined, 60));

    const response = await POST(request("POST", { requestType: "access" }));

    expect(response.status).toBe(429);
    expect(mocks.enforceUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", bucketKey: "privacy-requests.create" }),
    );
    expect(mocks.db.queries).toEqual([]);
  });

  it("files the request for the token's account, never for an account named in the body", async () => {
    const response = await POST(
      request("POST", { requestType: "erasure", userId: "user-2", user_id: "user-2" }),
    );

    expect(response.status).toBe(201);
    expectNoStore(response);
    expect(await response.json()).toMatchObject({ requestType: "erasure", status: "received" });
    expect(mocks.db.rows("data_subject_requests", { user_id: "user-2" })).toHaveLength(1);
    expect(
      mocks.db.rows("data_subject_requests", { user_id: "user-1", request_type: "erasure" }),
    ).toEqual([expect.objectContaining({ requester_email: "user-1@exemple.test" })]);
  });

  it("counts only the account's own open requests toward the limit of five", async () => {
    mocks.db = createFakeSupabase(
      { data_subject_requests: ["a", "b", "c", "d", "e"].map((id) => demand("user-2", id)) },
      { defaults: DEFAULTS },
    );

    const response = await POST(request("POST", { requestType: "access" }));

    expect(response.status).toBe(201);
    expect(mocks.db.rows("data_subject_requests", { user_id: "user-1" })).toHaveLength(1);
  });

  it("answers 500 with the generic message when the request cannot be filed for an unknown reason", async () => {
    mocks.enforceUser.mockRejectedValue(new Error("rate limit store unreachable"));

    const response = await POST(request("POST", { requestType: "access" }));

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(await response.json()).toMatchObject({
      error: "Demande impossible.",
      code: "INTERNAL_ERROR",
    });
    expect(mocks.db.rows("data_subject_requests")).toHaveLength(2);
  });
});
