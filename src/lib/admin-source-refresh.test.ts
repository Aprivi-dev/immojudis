import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  adminSourceRefreshRequestSchema,
  getAdminSourceRefreshStatus,
  requestAdminSourceRefresh,
} from "@/lib/admin-source-refresh";

const { serverFrom, serverRpc } = vi.hoisted(() => ({
  serverFrom: vi.fn(),
  serverRpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom, rpc: serverRpc },
}));

describe("admin source refresh", () => {
  beforeEach(() => {
    serverFrom.mockReset();
    serverRpc.mockReset();
    serverFrom.mockImplementation((table: string) =>
      table === "auction_sales" ? saleBuilder() : jobBuilder([sourceDetailJob()]),
    );
  });

  it("requires the admin role before touching the service admission", async () => {
    await expect(
      requestAdminSourceRefresh({
        auth: fakeAuth(false),
        input: { saleId: SALE_ID, force: true },
      }),
    ).rejects.toThrow("accès administrateur requis");
    expect(serverRpc).not.toHaveBeenCalled();
  });

  it("admits the exact sale through the bounded source-detail RPC", async () => {
    serverRpc.mockResolvedValue({
      data: [{ job_id: JOB_ID, reused: true }],
      error: null,
    });

    const response = await requestAdminSourceRefresh({
      auth: fakeAuth(true),
      input: adminSourceRefreshRequestSchema.parse({ saleId: SALE_ID, force: true }),
    });

    expect(serverRpc).toHaveBeenCalledWith("enqueue_admin_source_detail_bounded", {
      p_admin_id: ADMIN_ID,
      p_force: true,
      p_sale_id: SALE_ID,
    });
    expect(response).toMatchObject({
      ok: true,
      saleId: SALE_ID,
      request: {
        id: JOB_ID,
        saleId: SALE_ID,
        kind: "source_detail",
        sourceName: "avoventes",
        status: "queued",
        reused: true,
      },
    });
  });

  it("returns the latest exact-sale status and a bounded history", async () => {
    serverFrom.mockImplementation((table: string) =>
      table === "auction_sales"
        ? saleBuilder()
        : jobBuilder([
            sourceDetailJob({
              id: JOB_ID,
              status: "completed",
              completed_at: "2026-09-28T12:00:00.000Z",
            }),
            sourceDetailJob({ id: SECOND_JOB_ID, status: "failed", last_error: "timeout" }),
          ]),
    );

    const response = await getAdminSourceRefreshStatus({
      auth: fakeAuth(true),
      input: { saleId: SALE_ID },
    });

    expect(response.request).toMatchObject({ id: JOB_ID, status: "completed" });
    expect(response.history).toHaveLength(2);
    expect(response.history[1]).toMatchObject({ id: SECOND_JOB_ID, errorMessage: "timeout" });
  });

  it("surfaces a paused pipeline without writing directly to the queue", async () => {
    serverRpc.mockResolvedValue({
      data: null,
      error: { message: "ADMIN_SOURCE_DETAIL_PAUSED" },
    });

    await expect(
      requestAdminSourceRefresh({ auth: fakeAuth(true), input: { saleId: SALE_ID, force: true } }),
    ).rejects.toThrow("désactivé");
  });
});

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const SALE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_JOB_ID = "44444444-4444-4444-8444-444444444444";

function fakeAuth(isAdmin: boolean): SupabaseAuthContext {
  return {
    userId: ADMIN_ID,
    claims: { sub: ADMIN_ID },
    accountTier: "free",
    userRole: isAdmin ? "admin" : "user",
    isAdmin,
    supabase: {} as SupabaseAuthContext["supabase"],
  };
}

function saleBuilder() {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    async maybeSingle() {
      return {
        data: { id: SALE_ID, source_url: SOURCE_URL, source_name: "avoventes" },
        error: null,
      };
    },
  };
  return builder;
}

function jobBuilder(rows: ReturnType<typeof sourceDetailJob>[]) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(async () => ({ data: rows, error: null })),
  };
  return builder;
}

function sourceDetailJob(overrides: Partial<ReturnType<typeof baseSourceDetailJob>> = {}) {
  return { ...baseSourceDetailJob(), ...overrides };
}

function baseSourceDetailJob() {
  return {
    id: JOB_ID,
    source_url: SOURCE_URL,
    job_type: "source_detail" as const,
    status: "queued" as SourceDetailTestStatus,
    priority: 120,
    detail_source_name: "avoventes",
    detail_source_url: SOURCE_URL,
    attempt_count: 0,
    max_attempts: 4,
    locked_at: null as string | null,
    completed_at: null as string | null,
    last_error: null as string | null,
    created_at: "2026-09-28T10:00:00.000Z",
    updated_at: "2026-09-28T10:00:00.000Z",
    request_origin: "admin_information_agent" as const,
    requested_by: ADMIN_ID,
  };
}

const SOURCE_URL = "https://example.test/sale";

type SourceDetailTestStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
