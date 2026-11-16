import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; column: string; value: string }>,
  requestRow: {} as Record<string, unknown>,
  email: "Client@Example.test",
  rows: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("@/lib/billing-stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        getUserById: async () => ({
          data: {
            user: {
              email: state.email,
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
            data: state.rows[`${table}.${filter!.column}`] ?? [
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

import {
  ACCOUNT_EXPORT_RULES,
  collectAccountData,
  exportAccountPrivacyData,
  exportRow,
  THIRD_PARTY_MASK,
} from "./privacy-account-export";
import { ERASURE_TABLES } from "./privacy-requests";

const admin = { userId: "admin", isAdmin: true } as unknown as SupabaseAuthContext;

beforeEach(() => {
  state.reads = [];
  state.email = "Client@Example.test";
  state.rows = {};
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

describe("export : données de tiers et champs internes (art. 15.4 RGPD)", () => {
  const OTHER_ID = "33333333-3333-4333-8333-333333333333";
  const account = { id: USER_ID, email: "client@example.test" };
  const rule = (table: string) => ACCOUNT_EXPORT_RULES[table]!;

  it("chaque table de ERASURE_TABLES a une règle d'export déclarée, et seulement elles", () => {
    const tables = new Set(ERASURE_TABLES.map(([table]) => table));
    for (const table of tables) {
      expect(ACCOUNT_EXPORT_RULES, `règle d'export manquante : ${table}`).toHaveProperty([table]);
    }
    expect(Object.keys(ACCOUNT_EXPORT_RULES).sort()).toEqual([...tables].sort());
  });

  it("invitations : masque les autres personnes, garde le titulaire", () => {
    const sent = exportRow(
      {
        id: "c1",
        owner_id: USER_ID,
        invited_by: USER_ID,
        collaborator_user_id: OTHER_ID,
        invited_email: "collegue@example.test",
        role: "viewer",
      },
      rule("sale_workspace_collaborators"),
      account,
    );
    expect(sent).toEqual({
      id: "c1",
      owner_id: USER_ID,
      invited_by: USER_ID,
      collaborator_user_id: THIRD_PARTY_MASK,
      invited_email: THIRD_PARTY_MASK,
      role: "viewer",
    });
    const received = exportRow(
      {
        owner_id: OTHER_ID,
        invited_by: OTHER_ID,
        collaborator_user_id: USER_ID,
        invited_email: "Client@Example.test",
      },
      rule("sale_workspace_collaborators"),
      account,
    );
    expect(received).toEqual({
      owner_id: THIRD_PARTY_MASK,
      invited_by: THIRD_PARTY_MASK,
      collaborator_user_id: USER_ID,
      invited_email: "Client@Example.test",
    });
  });

  it("messages de l'agent : garde la demande du titulaire, masque la réponse et l'adresse du professionnel", () => {
    const metadata = {
      approved_by_admin: "admin-1",
      approval_sha256: "abc",
      manual_reply_provider_id: "prov-1",
      sender_name: "Maître Tiers",
      sender_email: "avocat@cabinet.test",
      address_origin_text: "annuaire du barreau",
      nested: { reviewed_by: "admin-2", provider_email_id: "x", kept: 1 },
      channel: "portal",
    };
    const outbound = exportRow(
      {
        direction: "outbound",
        message_kind: "initial",
        from_email: "agent@immojudis.test",
        to_email: "avocat@cabinet.test",
        subject: "Question sur la vente",
        body_text: "Ma question",
        provider_message_id: "re_1",
        metadata,
      },
      rule("information_agent_messages"),
      account,
    );
    expect(outbound).toEqual({
      direction: "outbound",
      message_kind: "initial",
      from_email: THIRD_PARTY_MASK,
      to_email: THIRD_PARTY_MASK,
      subject: "Question sur la vente",
      body_text: "Ma question",
      metadata: {
        sender_name: THIRD_PARTY_MASK,
        sender_email: THIRD_PARTY_MASK,
        address_origin_text: THIRD_PARTY_MASK,
        nested: { kept: 1 },
        channel: "portal",
      },
    });
    const inbound = exportRow(
      {
        direction: "inbound",
        message_kind: "reply",
        from_email: "avocat@cabinet.test",
        subject: "Re: Question",
        body_text: "Réponse du professionnel",
        attachments: [{ filename: "pv.pdf" }],
      },
      rule("information_agent_messages"),
      account,
    );
    expect(inbound).toEqual({
      direction: "inbound",
      message_kind: "reply",
      from_email: THIRD_PARTY_MASK,
      subject: THIRD_PARTY_MASK,
      body_text: THIRD_PARTY_MASK,
      attachments: THIRD_PARTY_MASK,
    });
  });

  it("demandes à l'agent : masque le destinataire, retire l'adresse de routage et les empreintes", () => {
    const mission = exportRow(
      {
        id: "m1",
        body_text: "Ma demande",
        recipient_email: "avocat@cabinet.test",
        recipient_name: "Maître Tiers",
        recipient_identity_keys: ["email:avocat@cabinet.test"],
        recipient_kind: "lawyer",
        reply_to_email: "reponse+abc@immojudis.test",
        approved_message_sha256: "abc",
        provider_message_id: "re_2",
        contribution_token_version: 2,
      },
      rule("information_agent_missions"),
      account,
    );
    expect(mission).toEqual({
      id: "m1",
      body_text: "Ma demande",
      recipient_email: THIRD_PARTY_MASK,
      recipient_name: THIRD_PARTY_MASK,
      recipient_identity_keys: THIRD_PARTY_MASK,
      recipient_kind: "lawyer",
    });
  });

  it("retire les notes et acteurs d'administration des demandes du titulaire", () => {
    expect(
      exportRow(
        {
          id: "l1",
          message: "Mon message",
          admin_notes: "note interne",
          requested_lawyer_id: OTHER_ID,
          requester_email: "client@example.test",
          metadata: { selected_lawyer_id: OTHER_ID, source: "sale_detail" },
        },
        rule("lawyer_referral_requests"),
        account,
      ),
    ).toEqual({
      id: "l1",
      message: "Mon message",
      requested_lawyer_id: THIRD_PARTY_MASK,
      requester_email: "client@example.test",
      metadata: { selected_lawyer_id: THIRD_PARTY_MASK, source: "sale_detail" },
    });
    expect(
      exportRow(
        { id: "p1", title: "Mon bien", admin_notes: "note", reviewed_by: OTHER_ID },
        rule("listing_publication_requests"),
        account,
      ),
    ).toEqual({ id: "p1", title: "Mon bien" });
  });

  it("collectAccountData applique les règles aux lignes lues", async () => {
    state.rows["sale_workspace_collaborators.owner_id"] = [
      { id: "c1", owner_id: USER_ID, invited_email: "collegue@example.test" },
    ];
    const result = await collectAccountData(USER_ID);
    expect(result.tables["sale_workspace_collaborators.owner_id"]?.rows).toEqual([
      { id: "c1", owner_id: USER_ID, invited_email: THIRD_PARTY_MASK },
    ]);
  });

  it("une adresse « *@x.fr » n'exporte pas l'invitation d'une autre adresse", async () => {
    state.email = "*@x.fr";
    state.rows["sale_workspace_collaborators.invited_email"] = [
      { id: "inv-other", invited_email: "autre@x.fr", owner_id: OTHER_ID },
      { id: "inv-own", invited_email: "*@X.fr", owner_id: OTHER_ID },
    ];
    const result = await collectAccountData(USER_ID);
    expect(state.reads).toContainEqual({
      table: "sale_workspace_collaborators",
      column: "invited_email",
      value: "_@x.fr",
    });
    expect(result.byAddress.workspaceInvitations.rows).toEqual([
      { id: "inv-own", invited_email: "*@X.fr", owner_id: THIRD_PARTY_MASK },
    ]);
    expect(JSON.stringify(result)).not.toContain("autre@x.fr");
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
