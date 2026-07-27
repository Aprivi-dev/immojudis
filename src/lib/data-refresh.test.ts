import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  DATA_REFRESH_REQUESTS_PER_MINUTE,
  dataRefreshRequestSchema,
  normalizeDataRefreshKindList,
  requestDataRefresh,
} from "@/lib/data-refresh";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { recordFeatureUsageEvent } from "@/lib/usage";

const { serverFrom, serverRpc } = vi.hoisted(() => ({
  serverFrom: vi.fn(),
  serverRpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom, rpc: serverRpc },
}));

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

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: vi.fn(async () => 1),
}));

describe("data refresh requests", () => {
  beforeEach(() => {
    serverFrom.mockReset();
    serverRpc.mockReset();
    serverRpc.mockImplementation(async (_name, args: { p_request_kind: string }) => ({
      data: [
        args.p_request_kind === "dpe"
          ? { request_id: DPE_REQUEST_ID, reused: true }
          : { request_id: CADASTRE_REQUEST_ID, reused: false },
      ],
      error: null,
    }));
  });

  it("normalizes refresh scopes and collapses full refreshes", () => {
    expect(normalizeDataRefreshKindList("cadastre,dpe")).toEqual(["cadastre", "dpe"]);
    expect(normalizeDataRefreshKindList(["dpe", "full", "cadastre"])).toEqual(["full"]);
    expect(dataRefreshRequestSchema.parse({ saleId: SALE_ID })).toMatchObject({
      saleId: SALE_ID,
      kinds: ["full"],
      force: false,
    });
  });

  it("admits refresh requests atomically and preserves exact deduplication", async () => {
    const auth = fakeRefreshAuth();
    serverFrom.mockImplementation((table: string) =>
      (auth.supabase as unknown as { from: (name: string) => unknown }).from(table),
    );

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
    expect(enforceUserRateLimit).toHaveBeenCalledWith({
      userId: USER_ID,
      bucketKey: "data.refresh",
      limit: DATA_REFRESH_REQUESTS_PER_MINUTE,
      windowSeconds: 60,
    });
    expect(serverRpc).toHaveBeenNthCalledWith(1, "enqueue_data_refresh_bounded", {
      p_force: true,
      p_request_kind: "cadastre",
      p_sale_id: SALE_ID,
      p_user_id: USER_ID,
    });
    expect(serverRpc).toHaveBeenNthCalledWith(2, "enqueue_data_refresh_bounded", {
      p_force: true,
      p_request_kind: "dpe",
      p_sale_id: SALE_ID,
      p_user_id: USER_ID,
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

  it("surfaces database backpressure as an API-rate-limit error", async () => {
    const auth = fakeRefreshAuth();
    serverFrom.mockImplementation((table: string) =>
      (auth.supabase as unknown as { from: (name: string) => unknown }).from(table),
    );
    serverRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "DATA_REFRESH_USER_ACTIVE_LIMIT" },
    });

    await expect(
      requestDataRefresh({
        auth,
        input: { saleId: SALE_ID, kinds: ["full"], force: false },
      }),
    ).rejects.toThrow("Trop de demandes de rafraîchissement");
  });
});

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SALE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://example.test/sale";
const DPE_REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const CADASTRE_REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function fakeRefreshAuth(): SupabaseAuthContext {
  const activeDpeRequest = refreshRow({
    id: DPE_REQUEST_ID,
    request_kind: "dpe",
    status: "running",
  });

  return {
    userId: USER_ID,
    claims: { sub: USER_ID },
    supabase: {
      from(table: string) {
        const state: {
          filters: Record<string, unknown>;
        } = {
          filters: {},
        };
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: unknown) {
            state.filters[column] = value;
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
            if (table === "data_refresh_requests" && state.filters.id === DPE_REQUEST_ID) {
              return { data: activeDpeRequest, error: null };
            }
            if (table === "data_refresh_requests" && state.filters.id === CADASTRE_REQUEST_ID) {
              return {
                data: refreshRow({
                  id: CADASTRE_REQUEST_ID,
                  status: "queued",
                }),
                error: null,
              };
            }
            return { data: null, error: new Error(`Unexpected single query on ${table}`) };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            resolve({ data: [], error: null });
          },
        };
        return builder;
      },
    },
  } as unknown as SupabaseAuthContext;
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
