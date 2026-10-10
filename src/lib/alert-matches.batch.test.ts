import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  userAlerts: [] as Row[],
  getSalesCalls: [] as Array<{ filters: Record<string, unknown>; limit: number; offset: number }>,
  salesPool: [] as Row[],
  updates: [] as Row[],
}));

function fakeClient() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let range: [number, number] | null = null;
      let op: "select" | "update" | "upsert" = "select";
      let patch: Row | null = null;
      let columns = "*";
      const chain: Record<string, unknown> = {
        select(value?: string) {
          if (value) columns = value;
          return chain;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return chain;
        },
        order: () => chain,
        in: () => chain,
        range(from: number, to: number) {
          range = [from, to];
          return chain;
        },
        update(value: Row) {
          op = "update";
          patch = value;
          return chain;
        },
        upsert: () => {
          op = "upsert";
          return chain;
        },
        then(resolve: (value: { data: unknown; error: null }) => void) {
          if (table === "user_alerts" && op === "update") {
            state.updates.push({ ...patch, id: filters.id });
            return resolve({ data: null, error: null });
          }
          if (table === "user_alerts") {
            let rows = state.userAlerts.filter((row) => row.is_active === true);
            if (filters.user_id) rows = rows.filter((row) => row.user_id === filters.user_id);
            if (columns === "user_id") rows = rows.map((row) => ({ user_id: row.user_id }));
            if (range) rows = rows.slice(range[0], range[1] + 1);
            return resolve({ data: rows, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeClient() }));
vi.mock("@/lib/system-auth", () => ({
  systemAuthForUser: async (userId: string) => ({
    supabase: fakeClient(),
    userId,
    claims: {},
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
  }),
}));
vi.mock("@/lib/property-reports", () => ({
  resolvePlanEntitlements: async () => ({ plan: "analyse", hasAnalysisAccess: true }),
}));
vi.mock("@/lib/queries", () => ({
  getSales: async (
    filters: Record<string, unknown>,
    limit: number,
    _sort: string,
    offset: number,
  ) => {
    state.getSalesCalls.push({ filters, limit, offset });
    return state.salesPool.slice(offset, offset + limit);
  },
}));
vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: async () => null }));
vi.mock("@/lib/alert-notifications", () => ({
  createAlertNotificationsForMatches: async () => ({ notificationCount: 0 }),
}));

import { runSmartAlertEvaluationBatch } from "./alert-matches";

function alertRow(index: number, overrides: Row = {}): Row {
  return {
    id: `alert-${index}`,
    user_id: `user-${index}`,
    name: `Alerte ${index}`,
    is_active: true,
    alert_frequency: "daily",
    last_evaluated_at: null,
    dpe_classes: [],
    advanced_criteria: {},
    ...overrides,
  };
}

describe("smart alert batch", () => {
  beforeEach(() => {
    state.userAlerts = [];
    state.salesPool = [];
    state.getSalesCalls = [];
    state.updates = [];
  });

  it("évalue les 100 alertes de test en une exécution, sans plafond d'utilisateurs", async () => {
    state.userAlerts = Array.from({ length: 100 }, (_, index) => alertRow(index));

    const result = await runSmartAlertEvaluationBatch();

    expect(result.candidateUserCount).toBe(100);
    expect(result.evaluatedUserCount).toBe(100);
    expect(result.failedUserCount).toBe(0);
    expect(result.deferredUserCount).toBe(0);
    expect(state.updates).toHaveLength(100);
    expect(state.updates.every((update) => update.last_evaluated_at)).toBe(true);
  });

  it("lit toutes les pages de ventes d'une alerte jamais évaluée", async () => {
    state.userAlerts = [alertRow(1)];
    state.salesPool = Array.from({ length: 950 }, (_, index) => ({ id: `sale-${index}` }));

    await runSmartAlertEvaluationBatch();

    expect(state.getSalesCalls.map((call) => call.offset)).toEqual([0, 400, 800]);
    expect(state.getSalesCalls[0].filters.updated_since).toBeUndefined();
    expect(state.getSalesCalls[0].filters.status_in).toEqual(["active", "upcoming"]);
  });

  it("ne relit que les ventes modifiées depuis la dernière évaluation", async () => {
    state.userAlerts = [alertRow(1, { last_evaluated_at: "2026-10-08T06:15:00.000Z" })];

    await runSmartAlertEvaluationBatch();

    const since = String(state.getSalesCalls[0].filters.updated_since);
    // One hour of overlap before the previous evaluation.
    expect(since).toBe("2026-10-08T05:15:00.000Z");
  });

  it("reporte les utilisateurs restants quand le budget de temps est épuisé", async () => {
    state.userAlerts = Array.from({ length: 6 }, (_, index) => alertRow(index));

    const result = await runSmartAlertEvaluationBatch({ timeBudgetMs: -1 });

    expect(result.deferredUserCount).toBe(6);
    expect(result.evaluatedUserCount).toBe(0);
    expect(state.updates).toHaveLength(0);
  });
});
