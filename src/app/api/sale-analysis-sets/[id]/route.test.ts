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

import { DELETE, PATCH } from "./route";

const OWN = "3b5d7f9a-1c3e-4a5b-8d7f-9a1b3c5d7e01";
const OTHER = "4c6e8a0b-2d4f-4b6c-9e8a-0b2c4d6e8f02";
const SALE = "5d7f9b1c-3e5a-4c7d-8f9b-1c3d5e7f9a03";

type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

function call(
  handler: Handler,
  method: "PATCH" | "DELETE",
  id: string,
  options: { body?: unknown; token?: boolean } = {},
) {
  const { body, token = true } = options;
  return handler(
    new Request(`https://immojudis.test/api/sale-analysis-sets/${id}`, {
      method,
      headers: token ? { authorization: "Bearer token" } : undefined,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function item(userId: string, setId: string, notes: string): FakeRow {
  return {
    id: `item-${userId}`,
    user_id: userId,
    analysis_set_id: setId,
    sale_id: SALE,
    item_order: 0,
    decision_status: "watching",
    notes,
  };
}

function analysisSet(userId: string, id: string, name: string): FakeRow {
  return {
    id,
    user_id: userId,
    name,
    analysis_kind: "watchlist",
    notes: `Notes de ${userId}`,
    assumptions: {},
    summary_snapshot: {},
    is_archived: false,
    share_token_hash: `hash-${userId}`,
    shared_snapshot: null,
    shared_at: null,
    share_expires_at: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
  };
}

describe("/api/sale-analysis-sets/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase(
      {
        user_sale_analysis_sets: [
          analysisSet("user-1", OWN, "Mes ventes"),
          analysisSet("user-2", OTHER, "Ventes d'autrui"),
        ],
        // Ligne artificielle : un bien d'un autre compte rattaché à l'ensemble ne doit pas sortir.
        user_sale_analysis_items: [
          item("user-1", OWN, "Ma note"),
          item("user-2", OWN, "Note d'autrui"),
        ],
        v_auction_sales_app: [{ id: SALE, title: "Maison", city: "Bordeaux" }],
        auction_sales: [{ id: SALE, status: "upcoming", catalogue_quarantined: false }],
      },
      {
        // La fonction SQL enregistre les métadonnées de l'ensemble désigné et le rend.
        rpc: (name, args) => {
          if (name !== "save_sale_analysis_set") throw new Error(`rpc inattendue ${name}`);
          const row = mocks.db.rows("user_sale_analysis_sets", { id: args.p_set_id })[0];
          Object.assign(row, { name: (args.p_metadata as FakeRow).name });
          return { data: { ...row }, error: null, count: null };
        },
      },
    );
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
      await call(PATCH, "PATCH", OWN, { body: { name: "Renommé" }, token: false }),
      await call(DELETE, "DELETE", OWN, { token: false }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
    expect(mocks.db.rpcCalls).toEqual([]);
  });

  it("answers 400 on an invalid id or an empty, malformed or invalid body, without writing", async () => {
    const responses = [
      await call(PATCH, "PATCH", "pas-un-uuid", { body: { name: "Renommé" } }),
      await call(DELETE, "DELETE", "pas-un-uuid"),
      ...(await Promise.all(
        ["", "{bad json", { name: "x" }, { items: [] }].map((body) =>
          call(PATCH, "PATCH", OWN, { body }),
        ),
      )),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
    expect(mocks.db.rpcCalls).toEqual([]);
  });

  it("updates the account's own set, counting only its own active sets toward the limit", async () => {
    // 20 analyses actives d'un autre compte : la limite Analyse (20) ne doit pas compter les siennes.
    mocks.db.tables.user_sale_analysis_sets.push(
      ...Array.from({ length: 20 }, (_, index) =>
        analysisSet("user-2", `other-${index}`, `Autre ${index}`),
      ),
    );

    const response = await call(PATCH, "PATCH", OWN, { body: { name: "Mes ventes 2026" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.set).toMatchObject({ id: OWN, name: "Mes ventes 2026" });
    expect(body.set).not.toHaveProperty("share_token_hash");
    expect(body.set.items.map((entry: { notes: string }) => entry.notes)).toEqual(["Ma note"]);
    expect(mocks.db.rpcCalls).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ p_set_id: OWN }) }),
    ]);
  });

  it("neither reads nor modifies a set of another account", async () => {
    const response = await call(PATCH, "PATCH", OTHER, { body: { name: "Volé" } });

    expect(response.ok).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("autrui");
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.db.rows("user_sale_analysis_sets", { id: OTHER })[0].name).toBe("Ventes d'autrui");
  });

  it("deletes the account's own set only", async () => {
    const response = await call(DELETE, "DELETE", OWN);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.db.rows("user_sale_analysis_sets").map((row) => row.id)).toEqual([OTHER]);
  });

  it("does not delete a set of another account", async () => {
    const response = await call(DELETE, "DELETE", OTHER);

    expect(response.ok).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.db.rows("user_sale_analysis_sets")).toHaveLength(2);
    expect(mocks.db.queries.filter((query) => query.action === "delete")).toEqual([]);
  });
});
