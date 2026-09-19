import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { PATCH } from "./route";

const request = (body: unknown) =>
  new Request("https://example.test/api/admin/pipeline/control", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

function mockUpdate(result: { data: unknown; error: { message: string } | null }) {
  const update = vi.fn();
  const eq = vi.fn();
  const select = vi.fn();
  const maybeSingle = vi.fn();
  mocks.from.mockReturnValue({ update });
  update.mockReturnValue({ eq });
  eq.mockReturnValue({ select });
  select.mockReturnValue({ maybeSingle });
  maybeSingle.mockResolvedValue(result);
  return { update, eq, select, maybeSingle };
}

beforeEach(() => vi.resetAllMocks());

it("authorizes before touching the database", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: false });

  const response = await PATCH(request({ enabled: true }));

  expect(response.status).toBe(403);
  expect(mocks.from).not.toHaveBeenCalled();
});

it.each([
  ["unknown fields", { enabled: true, cooldown_seconds: 30 }],
  ["empty objects", {}],
  ["invalid booleans", { enabled: "true" }],
  ["out of range prediction caps", { max_ai_predictions_per_run: 101 }],
  ["negative budgets", { daily_ai_budget_usd: -0.01 }],
  ["non-finite budgets", { daily_ai_budget_usd: Number.NaN }],
])("rejects %s before any update", async (_caseName, body) => {
  mocks.auth.mockResolvedValue({ isAdmin: true });

  const response = await PATCH(request(body));

  expect(response.status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});

it("updates only submitted settings and updated_at on the singleton", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  const updated = {
    id: true,
    enabled: false,
    source_details_enabled: true,
    max_ai_predictions_per_run: 25,
    daily_ai_budget_usd: 6.5,
    next_enrichment_at: "2026-09-19T10:00:00.000Z",
    observation_started_at: null,
    updated_at: "2026-09-19T12:00:00.000Z",
  };
  const { update, eq } = mockUpdate({ data: updated, error: null });

  const response = await PATCH(request({ enabled: false, daily_ai_budget_usd: 6.5 }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(updated);
  expect(mocks.from).toHaveBeenCalledWith("auction_pipeline_control");
  expect(update).toHaveBeenCalledWith({
    enabled: false,
    daily_ai_budget_usd: 6.5,
    updated_at: expect.any(String),
  });
  expect(eq).toHaveBeenCalledWith("id", true);
});

it("returns not found when the singleton row is missing", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  mockUpdate({ data: null, error: null });

  const response = await PATCH(request({ enabled: true }));

  expect(response.status).toBe(404);
});

it("returns a server error when the update fails", async () => {
  mocks.auth.mockResolvedValue({ isAdmin: true });
  mockUpdate({ data: null, error: { message: "database unavailable" } });

  const response = await PATCH(request({ enabled: true }));

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "database unavailable" });
});
