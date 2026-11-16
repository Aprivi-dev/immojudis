import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; column: string; value: string }>,
  requestRow: {} as Record<string, unknown>,
}));

vi.mock("@/lib/billing-stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: async () => ({
          data: {
            user: {
              email: "Client@Example.test",
              created_at: "2026-01-01T00:00:00.000Z",
              email_confirmed_at: "2026-01-01T00:05:00.000Z",
              last_sign_in_at: "2026-11-01T00:00:00.000Z",
            },
          },
          error: null,
        }),
      },
    },
    from(table: string) {
      let filter: { column: string; value: string } | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: string) => {
          filter = { column, value };
          return builder;
        },
        ilike: (column: string, value: string) => {
          filter = { column, value };
          return builder;
        },
        order: () => Promise.resolve({ data: [{ id: "r1", request_type: "access" }], error: null }),
        range: async () => {
          state.reads.push({ table, ...filter! });
          return {
            data: [
              {
                id: `${table}-1`,
                user_id: USER_ID,
                stripe_customer_id: "cus_secret",
                payment_intent_id: "pi_secret",
                key_hash: "hash",
                unsubscribe_token: "token",
                resend_email_id: "re_1",
                created_at: "2026-11-01T00:00:00.000Z",
              },
            ],
            error: null,
          };
        },
        single: async () => ({ data: state.requestRow, error: null }),
      };
      return builder;
    },
  },
}));

import { collectAccountData, exportAccountPrivacyData } from "./privacy-account-export";
import { ERASURE_TABLES } from "./privacy-requests";

const admin = { userId: "admin", isAdmin: true } as unknown as SupabaseAuthContext;

beforeEach(() => {
  state.reads = [];
  state.requestRow = {
    id: REQUEST_ID,
    request_type: "access",
    identity_status: "authenticated",
    user_id: USER_ID,
    metadata: { source: "authenticated_rights_portal" },
  };
});

describe("collectAccountData (M3)", () => {
  it("couvre chaque table de ERASURE_TABLES, la même liste que l'effacement", async () => {
    const result = await collectAccountData(USER_ID);
    for (const [table, column] of ERASURE_TABLES) {
      expect(result.tables, `${table}.${column}`).toHaveProperty([`${table}.${column}`]);
      expect(state.reads).toContainEqual({ table, column, value: USER_ID });
    }
    expect(Object.keys(result.tables)).toHaveLength(ERASURE_TABLES.length);
  });

  it("reprend aussi ce que l'effacement retrouve par l'adresse, en minuscules", async () => {
    const result = await collectAccountData(USER_ID);
    expect(state.reads).toContainEqual({
      table: "email_send_log",
      column: "to_address",
      value: "client@example.test",
    });
    expect(state.reads).toContainEqual({
      table: "sale_workspace_collaborators",
      column: "invited_email",
      value: "client@example.test",
    });
    expect(result.account).toMatchObject({ id: USER_ID, email: "Client@Example.test" });
    expect(result.privacyRequests).toHaveLength(1);
  });

  it("n'exporte ni secret, ni jeton, ni empreinte, ni identifiant Stripe ou Resend brut", async () => {
    const result = await collectAccountData(USER_ID);
    const serialized = JSON.stringify(result);
    for (const value of ["cus_secret", "pi_secret", "key_hash", "unsubscribe_token", "re_1"]) {
      expect(serialized).not.toContain(value);
    }
    expect(result.tables["user_favorites.user_id"]?.rows[0]).toEqual({
      id: "user_favorites-1",
      user_id: USER_ID,
      created_at: "2026-11-01T00:00:00.000Z",
    });
  });
});

describe("exportAccountPrivacyData", () => {
  it("réserve l'export aux demandes d'accès ou de portabilité d'un compte", async () => {
    await expect(
      exportAccountPrivacyData({
        auth: { userId: "u", isAdmin: false } as unknown as SupabaseAuthContext,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      exportAccountPrivacyData({ auth: admin, requestId: REQUEST_ID }),
    ).resolves.toHaveProperty("tables");

    state.requestRow = { ...state.requestRow, request_type: "erasure" };
    await expect(
      exportAccountPrivacyData({ auth: admin, requestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      status: 409,
    });
    state.requestRow = {
      ...state.requestRow,
      request_type: "access",
      identity_status: "additional_verification_required",
    };
    await expect(
      exportAccountPrivacyData({ auth: admin, requestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });
});
