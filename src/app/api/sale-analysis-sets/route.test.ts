import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow, type FakeSupabase } from "@/test/fake-supabase";
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

const OWN = "3b5d7f9a-1c3e-4a5b-8d7f-9a1b3c5d7e01";
const OWN_ARCHIVED = "3b5d7f9a-1c3e-4a5b-8d7f-9a1b3c5d7e02";
const OTHER = "4c6e8a0b-2d4f-4b6c-9e8a-0b2c4d6e8f02";
const SALE = "5d7f9b1c-3e5a-4c7d-8f9b-1c3d5e7f9a03";
const SALE_2 = "6e8a0c2d-4f6b-4d8e-9a0c-2d4e6f8a0b04";

function analysisSet(userId: string, id: string, name: string, archived = false): FakeRow {
  return {
    id,
    user_id: userId,
    name,
    analysis_kind: "comparison",
    notes: `Notes de ${userId}`,
    assumptions: {},
    summary_snapshot: {},
    is_archived: archived,
    share_token_hash: `hash-${userId}`,
    shared_snapshot: null,
    shared_at: null,
    share_expires_at: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: archived ? "2026-11-01T09:00:00.000Z" : "2026-11-01T10:00:00.000Z",
  };
}

function item(userId: string, setId: string, saleId: string, notes: string): FakeRow {
  return {
    id: `item-${userId}-${setId}`,
    user_id: userId,
    analysis_set_id: setId,
    sale_id: saleId,
    item_order: 0,
    decision_status: "watching",
    notes,
  };
}

function sale(id: string, city: string): FakeRow {
  return {
    id,
    city,
    department: "33",
    property_type: "house",
    sale_venue_type: "tribunal",
    sale_date: "2099-01-01T10:00:00.000Z",
    starting_price_eur: 100_000,
    status: "upcoming",
    catalogue_quarantined: false,
    raw_payload: {},
  };
}

function get(query = "", token = true) {
  return GET(
    new Request(`https://immojudis.test/api/sale-analysis-sets${query}`, {
      headers: token ? { authorization: "Bearer token" } : undefined,
    }),
  );
}

function post(body: unknown, token = true) {
  return POST(
    new Request("https://immojudis.test/api/sale-analysis-sets", {
      method: "POST",
      headers: token ? { authorization: "Bearer token" } : undefined,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("/api/sale-analysis-sets", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase(
      {
        user_sale_analysis_sets: [
          analysisSet("user-1", OWN, "Mes ventes"),
          analysisSet("user-1", OWN_ARCHIVED, "Mes anciennes ventes", true),
          analysisSet("user-2", OTHER, "Ventes d'autrui"),
        ],
        // Ligne artificielle : un bien d'un autre compte rattaché à l'ensemble ne doit pas sortir.
        user_sale_analysis_items: [
          item("user-1", OWN, SALE, "Ma note"),
          item("user-2", OWN, SALE_2, "Note d'autrui"),
          item("user-2", OTHER, SALE_2, "Note d'autrui"),
        ],
        v_auction_sales_app: [
          { id: SALE, title: "Maison", city: "Bordeaux" },
          { id: SALE_2, title: "Appartement", city: "Mérignac" },
        ],
        auction_sales: [sale(SALE, "Bordeaux"), sale(SALE_2, "Mérignac")],
      },
      {
        // La fonction SQL crée l'ensemble du compte appelant (son identifiant vient du jeton en base).
        rpc: (name, args) => {
          if (name !== "save_sale_analysis_set") throw new Error(`rpc inattendue ${name}`);
          const metadata = args.p_metadata as FakeRow;
          const row = analysisSet("user-1", randomUUID(), String(metadata.name));
          Object.assign(row, metadata, { share_token_hash: null });
          mocks.db.tables.user_sale_analysis_sets.push(row);
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
      await get("", false),
      await post({ name: "Ma sélection", items: [{ saleId: SALE }] }, false),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
    expect(mocks.db.rpcCalls).toEqual([]);
  });

  it("lists only the account's own active sets and items, without the share token hash", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.sets.map((set: { id: string }) => set.id)).toEqual([OWN]);
    expect(body.sets[0]).not.toHaveProperty("share_token_hash");
    expect(body.sets[0]).not.toHaveProperty("shared_snapshot");
    expect(body.sets[0].items.map((entry: { notes: string }) => entry.notes)).toEqual(["Ma note"]);
    expect(JSON.stringify(body)).not.toContain("autrui");
  });

  it("adds the archived sets of the account, and only them, with includeArchived=true", async () => {
    const response = await get("?includeArchived=true");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sets.map((set: { id: string }) => set.id).sort()).toEqual(
      [OWN, OWN_ARCHIVED].sort(),
    );
  });

  it("answers 400 on a malformed or invalid body, without writing", async () => {
    const responses = await Promise.all(
      [
        "",
        "{bad json",
        { name: "x", items: [{ saleId: SALE }] },
        { name: "Ma sélection", items: [] },
        { name: "Ma sélection", items: [{ saleId: "pas-un-uuid" }] },
      ].map((body) => post(body)),
    );
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.db.queries.filter((query) => query.action !== "select")).toEqual([]);
  });

  it("creates a comparison for the account, with a canonical snapshot of its sales", async () => {
    const response = await post({ name: "Ma sélection", items: [{ saleId: SALE }] });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.set).toMatchObject({ name: "Ma sélection", analysis_kind: "comparison" });
    expect(body.set).not.toHaveProperty("share_token_hash");
    expect(mocks.db.rpcCalls).toHaveLength(1);
    const { args } = mocks.db.rpcCalls[0];
    // Création : aucun ensemble existant désigné.
    expect(args).not.toHaveProperty("p_set_id");
    expect(args.p_items).toEqual([expect.objectContaining({ saleId: SALE })]);
    expect(
      ((args.p_metadata as FakeRow).summary_snapshot as { items: Array<{ id: string }> }).items.map(
        (entry) => entry.id,
      ),
    ).toEqual([SALE]);
  });

  it("does not take over another account's set that has the same name", async () => {
    const response = await post({ name: "Ventes d'autrui", items: [{ saleId: SALE }] });

    expect(response.status).toBe(200);
    expect(mocks.db.rpcCalls).toHaveLength(1);
    expect(mocks.db.rpcCalls[0].args).not.toHaveProperty("p_set_id");
    const other = mocks.db.rows("user_sale_analysis_sets", { id: OTHER })[0];
    expect(other).toMatchObject({ user_id: "user-2", name: "Ventes d'autrui" });
    expect(other.notes).toBe("Notes de user-2");
  });
});
