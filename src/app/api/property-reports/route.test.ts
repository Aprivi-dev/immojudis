import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow, type FakeSupabase } from "@/test/fake-supabase";
import { AuthRequiredError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  save: vi.fn(),
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
// La lecture et la validation sont celles du vrai module ; seule la construction du rapport (marché,
// cadastre, plafond…) est remplacée.
vi.mock("@/lib/property-reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/property-reports")>()),
  savePropertyReport: mocks.save,
}));

import { GET, POST } from "./route";

const SALE = "6e8a0c2d-4f6b-4d8e-9a0c-2d4e6f8a0b01";
const url = "https://immojudis.test/api/property-reports";

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

function report(userId: string, id: string): FakeRow {
  return {
    id,
    user_id: userId,
    sale_id: SALE,
    report_kind: "opportunity",
    title: `Rapport de ${userId}`,
    user_notes: `Notes privées de ${userId}`,
    updated_at: "2026-11-01T10:00:00.000Z",
  };
}

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/);
}

describe("/api/property-reports", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.db = createFakeSupabase({
      saved_property_reports: [report("user-1", "report-own"), report("user-2", "report-other")],
      auction_sales: [{ id: SALE, status: "upcoming", catalogue_quarantined: false }],
    });
    mocks.requireAuth.mockResolvedValue({
      userId: "user-1",
      supabase: mocks.db.client,
      claims: { sub: "user-1" },
      accountTier: "premium",
      userRole: "user",
      isAdmin: false,
    });
    mocks.save.mockImplementation(async ({ auth, input }) => ({
      report: { id: "report-new", user_id: auth.userId, sale_id: input.saleId },
      plan: { plan: "analyse" },
    }));
  });

  it("answers 401 without a token on both methods, before any query", async () => {
    for (const response of [
      await call(GET, "GET", { token: false }),
      await call(POST, "POST", { body: { saleId: SALE }, token: false }),
    ]) {
      expect(response.status).toBe(401);
      expectNoStore(response);
    }
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.db.queries).toEqual([]);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("answers 400 on an empty, malformed or invalid body, before building the report", async () => {
    for (const body of [
      "",
      "{bad json",
      {},
      { saleId: "pas-un-uuid" },
      { saleId: SALE, reportKind: "inconnu" },
    ]) {
      const response = await call(POST, "POST", { body });
      expect(response.status).toBe(400);
      expectNoStore(response);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("lists only the reports of the signed-in account, also when filtered by sale", async () => {
    for (const query of ["", `?saleId=${SALE}`]) {
      const response = await call(GET, "GET", { query });

      expect(response.status).toBe(200);
      expectNoStore(response);
      const body = await response.json();
      expect(body.reports.map((item: { id: string }) => item.id)).toEqual(["report-own"]);
      expect(JSON.stringify(body)).not.toContain("user-2");
    }
  });

  it("answers 403 to an account without saved reports, without reading any report", async () => {
    mocks.requireAuth.mockResolvedValue({
      userId: "user-1",
      supabase: mocks.db.client,
      claims: { sub: "user-1" },
      accountTier: "free",
      userRole: "user",
      isAdmin: false,
    });

    const response = await call(GET, "GET");

    expect(response.status).toBe(403);
    expectNoStore(response);
    expect(mocks.db.queries.map((query) => query.table)).not.toContain("saved_property_reports");
  });

  it("saves the report for the token's account, never for an account named in the body", async () => {
    const response = await call(POST, "POST", {
      body: { saleId: SALE, userId: "user-2", user_id: "user-2" },
    });

    expect(response.status).toBe(201);
    expectNoStore(response);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const [{ auth, input }] = mocks.save.mock.calls[0];
    expect(auth.userId).toBe("user-1");
    expect(input).toEqual({ saleId: SALE, reportKind: "opportunity", includeEnvironment: false });
  });

  it("answers 500 with the generic message when the report cannot be built for an unknown reason", async () => {
    mocks.save.mockRejectedValue(new Error("upstream timeout"));

    const response = await call(POST, "POST", { body: { saleId: SALE } });

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(await response.json()).toMatchObject({
      error: "Rapport impossible.",
      code: "INTERNAL_ERROR",
    });
  });
});
