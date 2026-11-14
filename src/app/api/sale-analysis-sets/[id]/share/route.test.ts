import { createHash } from "node:crypto";
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

import { DELETE, POST } from "./route";

const OWN = "3b5d7f9a-1c3e-4a5b-8d7f-9a1b3c5d7e01";
const OWN_WATCHLIST = "3b5d7f9a-1c3e-4a5b-8d7f-9a1b3c5d7e03";
const OTHER = "4c6e8a0b-2d4f-4b6c-9e8a-0b2c4d6e8f02";
const SALE = "5d7f9b1c-3e5a-4c7d-8f9b-1c3d5e7f9a03";
const SALE_2 = "6e8a0c2d-4f6b-4d8e-9a0c-2d4e6f8a0b04";
const DAY_MS = 24 * 60 * 60 * 1_000;

type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

function call(handler: Handler, method: "POST" | "DELETE", id: string, token = true) {
  return handler(
    new Request(`https://immojudis.test/api/sale-analysis-sets/${id}/share`, {
      method,
      headers: token ? { authorization: "Bearer token" } : undefined,
    }),
    { params: Promise.resolve({ id }) },
  );
}

function analysisSet(
  userId: string,
  id: string,
  kind: "comparison" | "watchlist" = "comparison",
): FakeRow {
  return {
    id,
    user_id: userId,
    name: `Ensemble ${id.slice(-2)}`,
    analysis_kind: kind,
    notes: null,
    assumptions: {},
    summary_snapshot: {},
    is_archived: false,
    share_token_hash: `hash-${userId}-${id.slice(-2)}`,
    shared_snapshot: { version: 1, items: [] },
    shared_at: "2026-11-01T10:00:00.000Z",
    share_expires_at: "2099-01-01T00:00:00.000Z",
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
  };
}

function item(userId: string, setId: string, saleId: string, order: number): FakeRow {
  return {
    id: `item-${userId}-${setId}-${order}`,
    user_id: userId,
    analysis_set_id: setId,
    sale_id: saleId,
    item_order: order,
    decision_status: "watching",
    notes: null,
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

describe("/api/sale-analysis-sets/[id]/share", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      user_sale_analysis_sets: [
        analysisSet("user-1", OWN),
        analysisSet("user-1", OWN_WATCHLIST, "watchlist"),
        analysisSet("user-2", OTHER),
      ],
      user_sale_analysis_items: [
        item("user-1", OWN, SALE, 0),
        // Ligne artificielle : le bien d'un autre compte rattaché à l'ensemble n'entre pas dans le lien.
        item("user-2", OWN, SALE_2, 1),
        item("user-1", OWN_WATCHLIST, SALE, 0),
        item("user-2", OTHER, SALE_2, 0),
      ],
      auction_sales: [sale(SALE, "Bordeaux"), sale(SALE_2, "Mérignac")],
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
      await call(POST, "POST", OWN, false),
      await call(DELETE, "DELETE", OWN, false),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
  });

  it("answers 400 on an id that is not a UUID, without any query", async () => {
    for (const response of [
      await call(POST, "POST", "pas-un-uuid"),
      await call(DELETE, "DELETE", "pas-un-uuid"),
    ]) {
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries).toEqual([]);
  });

  it("creates the shared link of the account's comparison: 30 days, token stored only as a hash", async () => {
    const before = Date.now();
    const response = await call(POST, "POST", OWN);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.enabled).toBe(true);
    const url = new URL(body.url);
    expect(url.origin).toBe("https://immojudis.test");
    const token = url.pathname.replace("/comparaisons/", "");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const expiresIn = Date.parse(body.expiresAt) - before;
    expect(expiresIn).toBeGreaterThan(30 * DAY_MS - 60_000);
    expect(expiresIn).toBeLessThanOrEqual(30 * DAY_MS + 60_000);

    const row = mocks.db.rows("user_sale_analysis_sets", { id: OWN })[0];
    expect(row.share_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.share_expires_at).toBe(body.expiresAt);
    // Seules les ventes du compte entrent dans l'instantané partagé.
    expect(
      (row.shared_snapshot as { items: Array<{ id: string }> }).items.map((entry) => entry.id),
    ).toEqual([SALE]);
    const update = mocks.db.queries.find((query) => query.action === "update")!;
    expect(update.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", column: "id", value: OWN },
        { op: "eq", column: "user_id", value: "user-1" },
      ]),
    );
  });

  it("neither shares nor unshares a set of another account", async () => {
    for (const response of [await call(POST, "POST", OTHER), await call(DELETE, "DELETE", OTHER)]) {
      expect(response.ok).toBe(false);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.db.queries.filter((query) => query.action === "update")).toEqual([]);
    expect(mocks.db.rows("user_sale_analysis_sets", { id: OTHER })[0]).toMatchObject({
      share_token_hash: "hash-user-2-02",
      shared_at: "2026-11-01T10:00:00.000Z",
    });
  });

  it("only shares comparisons", async () => {
    const response = await call(POST, "POST", OWN_WATCHLIST);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Seules les comparaisons");
    expect(mocks.db.queries.filter((query) => query.action === "update")).toEqual([]);
  });

  it("disables the shared link of the account's own comparison", async () => {
    const response = await call(DELETE, "DELETE", OWN);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, url: null, expiresAt: null });
    expect(mocks.db.rows("user_sale_analysis_sets", { id: OWN })[0]).toMatchObject({
      share_token_hash: null,
      shared_snapshot: null,
      shared_at: null,
      share_expires_at: null,
    });
    expect(mocks.db.rows("user_sale_analysis_sets", { id: OTHER })[0].share_token_hash).toBe(
      "hash-user-2-02",
    );
  });
});
