import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
import { GET, PATCH } from "./route";
beforeEach(() => vi.resetAllMocks());
it("does not read privileged pipeline data for a non-admin", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: false });
  expect((await GET(new Request("https://example.test/api/admin/pipeline"))).status).toBe(403);
  expect(mocks.from).not.toHaveBeenCalled();
});

it("returns the latest observation for every configured source", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  const observationSources: string[] = [];
  mocks.from.mockImplementation((table: string) => {
    if (table === "auction_source_state") {
      return {
        select: () => ({
          order: () =>
            Promise.resolve({
              data: [
                { source_name: "licitor", enabled: true },
                { source_name: "notaires", enabled: true },
              ],
              error: null,
            }),
        }),
      };
    }
    if (table === "auction_pipeline_control") {
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { enabled: true }, error: null }),
        }),
      };
    }
    if (table === "operational_alerts") {
      return {
        select: () => ({
          like: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      };
    }
    if (table === "auction_pipeline_observations") {
      return {
        select: () => ({
          eq: (_column: string, sourceName: string) => {
            observationSources.push(sourceName);
            return {
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: [
                      {
                        source_name: sourceName,
                        observed_at: "2026-10-04T10:00:00.000Z",
                        metrics: { freshness_ratio: 1 },
                      },
                    ],
                    error: null,
                  }),
              }),
            };
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  mocks.rpc.mockResolvedValue({
    data: {
      ai_requests: 0,
      ai_estimated_usd: 0,
      ai_unpriced_requests: 0,
      daily_ai_budget_usd: 5,
      runner_seconds: 0,
    },
    error: null,
  });

  const response = await GET(new Request("https://example.test/api/admin/pipeline"));

  expect(response.status).toBe(200);
  expect(observationSources).toEqual(["licitor", "notaires", "enrichment-queue"]);
  expect((await response.json()).observations).toHaveLength(3);
});

it("rejects unknown mutation fields before any database update", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  const response = await PATCH(
    new Request("https://example.test/api/admin/pipeline", {
      method: "PATCH",
      body: JSON.stringify({ source: "licitor", enabled: true, suspended_until: null }),
    }),
  );
  expect(response.status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});

it("rejects malformed JSON as a client error", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });

  const response = await PATCH(
    new Request("https://example.test/api/admin/pipeline", {
      method: "PATCH",
      body: "{",
    }),
  );

  expect(response.status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});
it("pause does not erase an access refusal cooldown", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  const update = vi.fn();
  mocks.from.mockReturnValue({ update });
  update.mockReturnValue({
    eq: () => ({
      select: () => ({
        maybeSingle: async () => ({ data: { source_name: "licitor", enabled: false } }),
      }),
    }),
  });
  const response = await PATCH(
    new Request("https://example.test/api/admin/pipeline", {
      method: "PATCH",
      body: JSON.stringify({ source: "licitor", enabled: false }),
    }),
  );
  expect(response.status).toBe(200);
  expect(update.mock.calls[0][0].enabled).toBe(false);
  expect(update.mock.calls[0][0]).not.toHaveProperty("suspended_until");
});
