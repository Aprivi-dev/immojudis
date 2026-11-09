import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), tables: [] as string[] }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "admin-jwt",
  requireSupabaseAuthContext: mocks.auth,
}));

function builder(table: string) {
  mocks.tables.push(table);
  const rows =
    table === "auction_runs"
      ? [
          { id: "run-1", status: "failed", source: "all", summary: {}, errors: {} },
          { id: "run-2", status: "queued", source: "all", summary: {}, errors: {} },
        ]
      : table === "auction_pipeline_control"
        ? [{ enabled: true }]
        : [];
  const result = { data: rows, error: null, count: 7 };
  const chain: Record<string, unknown> = {
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of ["select", "order", "limit", "range", "eq"]) chain[method] = () => chain;
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: builder,
    auth: { admin: {} },
  },
}));

import { GET } from "./route";

const get = (query = "") =>
  GET(
    new Request(`https://example.test/api/admin/dashboard${query}`, {
      headers: { authorization: "Bearer admin-jwt" },
    }),
  );

describe("GET /api/admin/dashboard?section=", () => {
  beforeEach(() => {
    mocks.tables.length = 0;
    mocks.auth.mockResolvedValue({ isAdmin: true, claims: { email: "admin@example.test" } });
  });

  it("section=runs reads only the runs and the pipeline switch", async () => {
    const response = await get("?section=runs");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=5");
    const body = await response.json();
    expect(body.stats).toEqual({ queuedRuns: 1, runningRuns: 0, failedRuns: 1 });
    expect(body.runs).toHaveLength(2);
    expect(body.runner.controlEnabled).toBe(true);
    expect(body).not.toHaveProperty("aiDescriptions");
    expect(body).not.toHaveProperty("counts");
    expect(new Set(mocks.tables)).toEqual(new Set(["auction_runs", "auction_pipeline_control"]));
  });

  it("section=counts runs the six exact counts and nothing else", async () => {
    const response = await get("?section=counts");
    expect(response.status).toBe(200);
    expect((await response.json()).counts).toEqual({
      sales: 7,
      documents: 7,
      extractions: 7,
      riskOccurrences: 7,
      scoreFactors: 7,
      runs: 7,
    });
    expect(new Set(mocks.tables)).toEqual(
      new Set([
        "auction_sales",
        "auction_documents",
        "auction_extractions",
        "auction_risk_occurrences",
        "auction_score_factors",
        "auction_runs",
      ]),
    );
  });

  it("without a section keeps the historical full payload", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.stats).toMatchObject({
      sales: 7,
      queuedRuns: 1,
      failedRuns: 1,
    });
    // La couverture des synthèses IA (plus produites par le pipeline) n'est plus calculée.
    expect(body.stats).not.toHaveProperty("aiDescriptions");
  });

  it.each(["?section=everything", "?section=", "?foo=bar", "?section=ai"])(
    "rejects %s with 400 before any database read",
    async (query) => {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(mocks.tables).toEqual([]);
    },
  );

  it("never computes a section for a non-admin", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, claims: {} });
    const response = await get("?section=counts");
    expect(response.status).toBe(403);
    expect(mocks.tables).toEqual([]);
  });
});
