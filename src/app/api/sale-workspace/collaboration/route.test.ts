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
// L'acceptation d'invitation lit et écrit avec le rôle de service (sans RLS).
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));

import { GET, PATCH, POST } from "./route";

const SALE_OWN = "1d3f5b7c-9e1a-4c3d-8f5b-7c9e1a3d5f01";
const SALE_OTHER = "2e4a6c8d-0f2b-4d4e-9a6c-8d0f2b4e6a02";
const INVITE_OTHER = "3f5b7d9e-1a3c-4e5f-8b7d-9e1a3c5f7b03";
const INVITE_OWN = "4a6c8e0f-2b4d-4f6a-9c8e-0f2b4d6a8c04";
const ANNOTATION_OWN = "5b7d9f1a-3c5e-4a7b-8d9f-1a3c5e7b9d05";
const url = "https://immojudis.test/api/sale-workspace/collaboration";

type Method = "GET" | "POST" | "PATCH";

function call(
  handler: (request: Request) => Promise<Response>,
  method: Method,
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

function workspace(id: string, userId: string, saleId: string): FakeRow {
  return { id, user_id: userId, sale_id: saleId, updated_at: "2026-11-01T10:00:00.000Z" };
}

function annotation(id: string, workspaceId: string, saleId: string, body: string): FakeRow {
  return {
    id,
    workspace_id: workspaceId,
    sale_id: saleId,
    author_id: workspaceId === "ws-own" ? "user-1" : "user-2",
    body,
    status: "open",
    created_at: "2026-11-01T10:00:00.000Z",
  };
}

function invitation(id: string, workspaceId: string, invitedEmail: string): FakeRow {
  return {
    id,
    workspace_id: workspaceId,
    owner_id: "user-2",
    invited_email: invitedEmail,
    role: "commenter",
    status: "invited",
    collaborator_user_id: null,
    created_at: "2026-11-01T10:00:00.000Z",
  };
}

describe("/api/sale-workspace/collaboration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase(
      {
        sale_workspaces: [
          workspace("ws-own", "user-1", SALE_OWN),
          workspace("ws-other", "user-2", SALE_OTHER),
        ],
        sale_workspace_annotations: [
          annotation(ANNOTATION_OWN, "ws-own", SALE_OWN, "Mon annotation"),
          annotation("ann-other", "ws-other", SALE_OTHER, "Annotation d'autrui"),
        ],
        sale_workspace_collaborators: [
          invitation(INVITE_OTHER, "ws-other", "user-3@exemple.test"),
          invitation(INVITE_OWN, "ws-other", "user-1@exemple.test"),
          // Un autre compte a accepté son invitation : cela ne donne aucun accès à user-1.
          {
            ...invitation("collab-user-3", "ws-other", "user-3@exemple.test"),
            status: "accepted",
            collaborator_user_id: "user-3",
          },
        ],
      },
      {
        users: {
          "user-1": {
            id: "user-1",
            email: "user-1@exemple.test",
            email_confirmed_at: "2026-10-01T10:00:00.000Z",
          },
        },
      },
    );
    // Compte premium (offre Analyse) : la collaboration n'en fait plus partie (n° 97).
    mocks.requireAuth.mockResolvedValue({
      userId: "user-1",
      supabase: mocks.db.client,
      claims: { sub: "user-1", email: "user-1@exemple.test" },
      accountTier: "premium",
      userRole: "user",
      isAdmin: false,
    });
  });

  it("answers 401 without a token on every method, before any query", async () => {
    for (const response of [
      await call(GET, "GET", { query: `?saleId=${SALE_OWN}`, token: false }),
      await call(POST, "POST", {
        body: { action: "accept", data: { collaboratorId: INVITE_OWN } },
        token: false,
      }),
      await call(PATCH, "PATCH", {
        body: { action: "revoke", data: { collaboratorId: INVITE_OWN } },
        token: false,
      }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on a missing saleId or an empty, malformed or invalid body", async () => {
    const cases: Array<[(request: Request) => Promise<Response>, Method, unknown, string?]> = [
      [GET, "GET", undefined],
      [GET, "GET", undefined, "?saleId=pas-un-uuid"],
      [POST, "POST", ""],
      [POST, "POST", "{bad json"],
      [POST, "POST", {}],
      [POST, "POST", { action: "inconnue", data: {} }],
      [
        POST,
        "POST",
        { action: "invite", data: { saleId: SALE_OWN, invitedEmail: "pas-un-email" } },
      ],
      [POST, "POST", { action: "annotate", data: { saleId: SALE_OWN, body: "" } }],
      [PATCH, "PATCH", ""],
      [PATCH, "PATCH", {}],
      [PATCH, "PATCH", { action: "revoke", data: { collaboratorId: "pas-un-uuid" } }],
      [PATCH, "PATCH", { action: "update_annotation", data: { annotationId: "pas-un-uuid" } }],
    ];
    for (const [handler, method, body, query] of cases) {
      const response = await call(handler, method, { body, query });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
  });

  it("lists the account's own workspace with private no-store", async () => {
    const response = await call(GET, "GET", { query: `?saleId=${SALE_OWN}` });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ workspaceId: "ws-own", role: "owner", collaborators: [] });
    expect(body.annotations.map((item: { body: string }) => item.body)).toEqual(["Mon annotation"]);
  });

  it("does not open another account's workspace to a non-collaborator", async () => {
    const response = await call(GET, "GET", { query: `?saleId=${SALE_OTHER}` });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ workspaceId: null, role: null, annotations: [] });
    expect(JSON.stringify(body)).not.toContain("autrui");
  });

  it("does not let an account accept an invitation sent to another address", async () => {
    const response = await call(POST, "POST", {
      body: { action: "accept", data: { collaboratorId: INVITE_OTHER } },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("sale_workspace_collaborators", { id: INVITE_OTHER })).toEqual([
      invitation(INVITE_OTHER, "ws-other", "user-3@exemple.test"),
    ]);
  });

  it("accepts an invitation sent to the account's confirmed address", async () => {
    const response = await call(POST, "POST", {
      body: { action: "accept", data: { collaboratorId: INVITE_OWN } },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("sale_workspace_collaborators", { id: INVITE_OWN })).toEqual([
      expect.objectContaining({ status: "accepted", collaborator_user_id: "user-1" }),
    ]);
  });

  it("does not annotate another account's workspace", async () => {
    const response = await call(POST, "POST", {
      body: { action: "annotate", data: { saleId: SALE_OTHER, body: "Intrusion" } },
    });

    expect(response.ok).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("sale_workspace_annotations", { workspace_id: "ws-other" })).toHaveLength(
      1,
    );
    expect(mocks.db.rows("sale_workspace_annotations", { body: "Intrusion" })).toEqual([]);
  });

  it("annotates the account's own workspace with private no-store", async () => {
    const response = await call(POST, "POST", {
      body: { action: "annotate", data: { saleId: SALE_OWN, body: "Visite prévue" } },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("sale_workspace_annotations", { body: "Visite prévue" })).toEqual([
      expect.objectContaining({ workspace_id: "ws-own", author_id: "user-1" }),
    ]);
  });

  it("updates an annotation with private no-store", async () => {
    const response = await call(PATCH, "PATCH", {
      body: {
        action: "update_annotation",
        data: { annotationId: ANNOTATION_OWN, status: "resolved" },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).annotation).toMatchObject({ status: "resolved" });
  });
});
