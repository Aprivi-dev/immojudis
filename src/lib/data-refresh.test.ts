import { describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  dataRefreshRequestSchema,
  normalizeDataRefreshKindList,
  requestDataRefresh,
} from "@/lib/data-refresh";
import { recordFeatureUsageEvent } from "@/lib/usage";

vi.mock("@/lib/property-reports", () => ({
  resolvePlanEntitlements: vi.fn(async () => ({
    plan: "analyse",
    label: "Analyse",
    limits: {},
    features: {},
  })),
}));

vi.mock("@/lib/usage", () => ({
  recordFeatureUsageEvent: vi.fn(async () => undefined),
}));

describe("data refresh requests", () => {
  it("normalizes refresh scopes and collapses full refreshes", () => {
    expect(normalizeDataRefreshKindList("cadastre,dpe")).toEqual(["cadastre", "dpe"]);
    expect(normalizeDataRefreshKindList(["dpe", "full", "cadastre"])).toEqual(["full"]);
    expect(dataRefreshRequestSchema.parse({ saleId: SALE_ID })).toMatchObject({
      saleId: SALE_ID,
      kinds: ["full"],
      force: false,
    });
  });

  it("creates missing refresh requests and reuses an active request for the same sale", async () => {
    const auth = fakeRefreshAuth();

    const response = await requestDataRefresh({
      auth,
      input: {
        saleId: SALE_ID,
        kinds: ["cadastre", "dpe"],
        force: true,
      },
    });

    expect(response.sale).toMatchObject({
      id: SALE_ID,
      sourceUrl: SOURCE_URL,
      city: "Bordeaux",
    });
    expect(response.requests).toHaveLength(2);
    expect(response.requests.map((request) => [request.kind, request.reused])).toEqual([
      ["cadastre", false],
      ["dpe", true],
    ]);
    expect(auth.inserts).toHaveLength(1);
    expect(auth.inserts[0]).toMatchObject({
      user_id: USER_ID,
      sale_id: SALE_ID,
      source_url: SOURCE_URL,
      request_kind: "cadastre",
      priority: 60,
      requested_payload: {
        force: true,
        requested_from: "app",
      },
    });
    expect(recordFeatureUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        auth,
        eventKey: "data_refresh.requested",
        subjectId: SALE_ID,
        quantity: 1,
      }),
    );
  });
});

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SALE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://example.test/sale";

function fakeRefreshAuth(): SupabaseAuthContext & { inserts: Record<string, unknown>[] } {
  const inserts: Record<string, unknown>[] = [];
  const activeDpeRequest = refreshRow({
    id: "33333333-3333-4333-8333-333333333333",
    request_kind: "dpe",
    status: "running",
  });

  return {
    userId: USER_ID,
    claims: { sub: USER_ID },
    inserts,
    supabase: {
      from(table: string) {
        const state: {
          filters: Record<string, unknown>;
          insertPayload: Record<string, unknown> | null;
        } = {
          filters: {},
          insertPayload: null,
        };
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: unknown) {
            state.filters[column] = value;
            return builder;
          },
          in(column: string, value: unknown) {
            state.filters[column] = value;
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          insert(payload: Record<string, unknown>) {
            inserts.push(payload);
            state.insertPayload = payload;
            return builder;
          },
          async single() {
            if (table === "auction_sales") {
              return {
                data: {
                  id: SALE_ID,
                  source_url: SOURCE_URL,
                  title: "Appartement judiciaire",
                  city: "Bordeaux",
                  department: "33",
                },
                error: null,
              };
            }
            if (table === "data_refresh_requests" && state.insertPayload) {
              return {
                data: refreshRow({
                  ...state.insertPayload,
                  id: "44444444-4444-4444-8444-444444444444",
                  status: "queued",
                }),
                error: null,
              };
            }
            return { data: null, error: new Error(`Unexpected single query on ${table}`) };
          },
          async maybeSingle() {
            if (
              table === "data_refresh_requests" &&
              state.filters.request_kind === "dpe" &&
              state.filters.source_url === SOURCE_URL
            ) {
              return { data: activeDpeRequest, error: null };
            }
            return { data: null, error: null };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            resolve({ data: [], error: null });
          },
        };
        return builder;
      },
    },
  } as unknown as SupabaseAuthContext & { inserts: Record<string, unknown>[] };
}

function refreshRow(overrides: Record<string, unknown>) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    user_id: USER_ID,
    sale_id: SALE_ID,
    source_url: SOURCE_URL,
    request_kind: "cadastre",
    status: "queued",
    priority: 60,
    requested_payload: {},
    result_summary: {},
    error_message: null,
    started_at: null,
    completed_at: null,
    created_at: "2026-07-06T10:00:00.000Z",
    updated_at: "2026-07-06T10:00:00.000Z",
    ...overrides,
  };
}
