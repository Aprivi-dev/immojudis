import { afterEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@/integrations/supabase/types";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  from: vi.fn(),
  getUserById: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { admin: { getUserById: mocks.getUserById } },
  },
}));

import {
  adminSubscriptionGrantInputSchema,
  grantAdminSubscription,
  listAdminSubscriptions,
  MANUAL_GRANT_HISTORY_MAX,
  manualSubscriptionPayload,
  withManualGrant,
} from "@/lib/admin-subscriptions";

afterEach(() => vi.resetAllMocks());

describe("admin subscriptions", () => {
  it("rejects an invalid manual period instead of throwing during date serialization", () => {
    expect(() =>
      adminSubscriptionGrantInputSchema.parse({
        target: "investisseur@example.test",
        currentPeriodEnd: "not-a-date",
      }),
    ).toThrow("La fin de période doit être une date valide");
  });

  it("normalizes manual grant input and preserves existing Stripe identifiers", () => {
    const input = adminSubscriptionGrantInputSchema.parse({
      target: "investisseur@example.test",
      planCode: "analyse",
      status: "trialing",
      currentPeriodEnd: "2026-08-01T12:30:00.000Z",
      note: "Accès pilote",
    });

    const payload = manualSubscriptionPayload({
      input,
      user: { id: "b8d4f60a-9e58-4a4c-83d7-30874062a395" },
      grantedBy: "3f1a1d80-8163-46b8-84de-fcfef5875652",
      existing: {
        stripe_customer_id: "cus_existing",
        stripe_subscription_id: "sub_existing",
        metadata: { previous: true },
      },
    });

    expect(payload).toMatchObject({
      user_id: "b8d4f60a-9e58-4a4c-83d7-30874062a395",
      plan_code: "analyse",
      status: "trialing",
      stripe_customer_id: "cus_existing",
      stripe_subscription_id: "sub_existing",
    });
    expect(payload.current_period_end).toBe("2026-08-01T12:30:00.000Z");
    expect(payload.metadata).toMatchObject({
      previous: true,
      manual_grant: {
        source: "admin",
        granted_by: "3f1a1d80-8163-46b8-84de-fcfef5875652",
        plan_code: "analyse",
        status: "trialing",
      },
    });
    // Le motif n'est jamais écrit dans la ligne lisible par le compte.
    expect(JSON.stringify(payload)).not.toContain("Accès pilote");
  });

  it("ne recopie pas l'adresse email et garde l'attribution précédente en historique", () => {
    const input = adminSubscriptionGrantInputSchema.parse({
      target: "investisseur@example.test",
      planCode: "analyse",
      status: "active",
      note: "Deuxième accès",
    });
    const payload = manualSubscriptionPayload({
      input,
      user: { id: "b8d4f60a-9e58-4a4c-83d7-30874062a395" },
      grantedBy: "3f1a1d80-8163-46b8-84de-fcfef5875652",
      existing: {
        stripe_customer_id: null,
        stripe_subscription_id: null,
        metadata: {
          manual_grant: {
            source: "admin",
            note: "Premier accès",
            target_email: "investisseur@example.test",
            status: "trialing",
          },
        },
      },
    });

    const metadata = payload.metadata as {
      manual_grant: Record<string, unknown>;
      manual_grant_history: Array<Record<string, unknown>>;
    };
    expect(metadata.manual_grant).not.toHaveProperty("target_email");
    expect(metadata.manual_grant).toMatchObject({ status: "active" });
    expect(JSON.stringify(payload.metadata)).not.toContain("Deuxième accès");
    expect(JSON.stringify(payload.metadata)).not.toContain("Premier accès");
    expect(metadata.manual_grant_history).toEqual([{ source: "admin", status: "trialing" }]);
    expect(JSON.stringify(payload.metadata)).not.toContain("investisseur@example.test");
  });

  describe("attribution manuelle", () => {
    const USER_ID = "b8d4f60a-9e58-4a4c-83d7-30874062a395";
    const ADMIN_ID = "3f1a1d80-8163-46b8-84de-fcfef5875652";
    const row = {
      user_id: USER_ID,
      plan_code: "analyse",
      status: "active",
      current_period_end: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      metadata: {},
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    };
    const arrange = () => {
      mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: ADMIN_ID });
      mocks.getUserById.mockResolvedValue({
        data: { user: { id: USER_ID, email: "a@example.test" } },
      });
      const upsert = vi.fn();
      const read = queryBuilder({ data: row, error: null });
      (read as Record<string, unknown>).maybeSingle = () =>
        Promise.resolve({ data: row, error: null });
      const write = {
        upsert: upsert.mockReturnValue({
          select: () => ({ single: async () => ({ data: row, error: null }) }),
        }),
        select: () => read,
      };
      mocks.from.mockReturnValue(write);
      return { upsert };
    };
    const grant = (note?: string) =>
      grantAdminSubscription({
        authToken: "token",
        input: adminSubscriptionGrantInputSchema.parse({
          target: USER_ID,
          planCode: "analyse",
          note,
        }),
      });

    it("avec un motif : une fonction écrit la ligne et le motif ensemble, la ligne n'en garde rien", async () => {
      const { upsert } = arrange();
      mocks.rpc.mockResolvedValue({ data: null, error: null });

      const response = await grant("Geste commercial");

      expect(response.subscription.userId).toBe(USER_ID);
      expect(upsert).not.toHaveBeenCalled();
      expect(mocks.rpc).toHaveBeenCalledWith(
        "grant_manual_subscription",
        expect.objectContaining({
          p_user_id: USER_ID,
          p_granted_by: ADMIN_ID,
          p_plan_code: "analyse",
          p_note: "Geste commercial",
        }),
      );
      expect(JSON.stringify(mocks.rpc.mock.calls[0][1].p_metadata)).not.toContain(
        "Geste commercial",
      );
    });

    it("avec un motif et sans la fonction : refuse, sans jamais remettre le motif dans la ligne", async () => {
      const { upsert } = arrange();
      mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "absent" } });

      await expect(grant("Geste commercial")).rejects.toThrow(/migration en attente/);
      expect(upsert).not.toHaveBeenCalled();
    });

    it("sans motif : écrit la ligne comme avant, sans appeler la fonction", async () => {
      const { upsert } = arrange();

      await grant();

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(mocks.rpc).not.toHaveBeenCalled();
    });
  });

  it("garde dix attributions au plus, les plus récentes d'abord", () => {
    let metadata: Json = {};
    for (let index = 1; index <= 13; index += 1) {
      metadata = withManualGrant(metadata, { source: "admin", sequence: index }) as Json;
    }
    const { manual_grant: current, manual_grant_history: history } = metadata as unknown as {
      manual_grant: { sequence: number };
      manual_grant_history: Array<{ sequence: number }>;
    };
    expect(current.sequence).toBe(13);
    expect(history).toHaveLength(MANUAL_GRANT_HISTORY_MAX);
    expect(history.map((entry) => entry.sequence)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("resolves every email on a 100-row admin page", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      user_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      plan_code: "analyse",
      status: "active",
      current_period_end: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      metadata: {},
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }));
    const pageQuery = queryBuilder({ data: rows, error: null, count: 100 });
    const activeQuery = queryBuilder({ data: null, error: null, count: 100 });
    mocks.from.mockReturnValueOnce(pageQuery).mockReturnValueOnce(activeQuery);
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin" });
    mocks.getUserById.mockImplementation(async (userId: string) => ({
      data: { user: { email: `${userId.slice(-4)}@example.test` } },
    }));

    const result = await listAdminSubscriptions("admin-token", { limit: 100 });

    expect(result.subscriptions).toHaveLength(100);
    expect(result.subscriptions.every((subscription) => subscription.email)).toBe(true);
    expect(mocks.getUserById).toHaveBeenCalledTimes(100);
  });
});

function queryBuilder(result: unknown) {
  const query = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    range: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)),
  };
  return query;
}
