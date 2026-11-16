import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  notifyClosed: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy({}, { get: (_, key) => Reflect.get(mocks.db.client, key) }),
}));
vi.mock("@/lib/billing-stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/privacy-request-notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/privacy-request-notifications")>()),
  notifyPrivacyRequestClosed: mocks.notifyClosed,
}));

import { privacyRequestAdminUpdateSchema, updatePrivacyRequestForAdmin } from "./privacy-requests";

const admin = { userId: "admin", isAdmin: true } as unknown as SupabaseAuthContext;

function demand(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    user_id: "11111111-1111-4111-8111-111111111111",
    requester_email: "client@example.test",
    request_type: "erasure",
    status: "in_review",
    identity_status: "verified",
    message: null,
    submitted_at: "2026-11-15T09:00:00.000Z",
    acknowledged_at: null,
    due_at: "2026-12-15T09:00:00.000Z",
    completed_at: null,
    resolution_code: null,
    operator_notes: null,
    metadata: { source: "authenticated_rights_portal" },
    ...overrides,
  };
}

function update(input: Record<string, unknown>) {
  return updatePrivacyRequestForAdmin({
    auth: admin,
    input: { requestId: REQUEST_ID, status: "completed", ...input } as never,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db = createFakeSupabase({ data_subject_requests: [demand()] });
});

describe("updatePrivacyRequestForAdmin", () => {
  it("F4 : refuse « Traitée » pour un effacement non exécuté, sans rien écrire", async () => {
    await expect(update({ resolutionCode: "erasure_executed" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(update({ resolutionCode: "done" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.db.rows("data_subject_requests")[0]).toMatchObject({ status: "in_review" });
    expect(mocks.notifyClosed).not.toHaveBeenCalled();
  });

  it("F4 : accepte un code explicite sans exécution, et le refus", async () => {
    await expect(update({ resolutionCode: "erasure_not_applicable" })).resolves.toMatchObject({
      status: "completed",
    });
    mocks.db = createFakeSupabase({ data_subject_requests: [demand()] });
    await expect(
      update({ status: "rejected", resolutionCode: "erasure_refused", response: "Motif." }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("F4 : une demande déjà exécutée se réenregistre avec son code", async () => {
    mocks.db = createFakeSupabase({
      data_subject_requests: [
        demand({
          status: "completed",
          resolution_code: "erasure_executed",
          completed_at: "2026-11-20T09:00:00.000Z",
        }),
      ],
    });
    await expect(
      update({ resolutionCode: "erasure_executed", operatorNotes: "Copie envoyée." }),
    ).resolves.toMatchObject({ status: "completed" });
    // Déjà close : pas de second email de clôture.
    expect(mocks.notifyClosed).not.toHaveBeenCalled();
  });

  it("E2 : la clôture pose l'email en attente, avec la réponse au demandeur, puis l'envoie", async () => {
    mocks.db = createFakeSupabase({
      data_subject_requests: [demand({ request_type: "rectification" })],
    });
    const summary = await update({
      status: "rejected",
      resolutionCode: "rectification_refused",
      response: "L’information figure telle quelle dans l’annonce.",
    });

    const [row] = mocks.db.rows("data_subject_requests");
    expect(row?.metadata).toMatchObject({
      source: "authenticated_rights_portal",
      notifications: {
        closure: {
          status: "pending",
          outcome: "rejected",
          erasure_executed: false,
          response: "L’information figure telle quelle dans l’annonce.",
        },
      },
    });
    expect(mocks.notifyClosed).toHaveBeenCalledWith(expect.objectContaining({ id: REQUEST_ID }));
    expect(summary).toMatchObject({
      closureResponse: "L’information figure telle quelle dans l’annonce.",
      notifications: { closure: "pending" },
    });
  });

  it("une mise à jour sans clôture ne touche pas aux métadonnées ni aux emails", async () => {
    await update({ status: "identity_verification" });
    expect(mocks.db.rows("data_subject_requests")[0]?.metadata).toEqual({
      source: "authenticated_rights_portal",
    });
    expect(mocks.notifyClosed).not.toHaveBeenCalled();
  });

  it("un refus exige une réponse au demandeur (motifs, art. 12.4 RGPD), au moment de clore", async () => {
    mocks.db = createFakeSupabase({
      data_subject_requests: [demand({ request_type: "objection" })],
    });
    await expect(
      update({ status: "rejected", resolutionCode: "objection_refused" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.db.rows("data_subject_requests")[0]).toMatchObject({ status: "in_review" });

    // Une demande déjà refusée (avant ce suivi) se réenregistre sans réponse.
    mocks.db = createFakeSupabase({
      data_subject_requests: [
        demand({
          request_type: "objection",
          status: "rejected",
          resolution_code: "objection_refused",
          completed_at: "2026-11-01T09:00:00.000Z",
        }),
      ],
    });
    await expect(
      update({ status: "rejected", resolutionCode: "objection_refused", operatorNotes: "Vu." }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(
      privacyRequestAdminUpdateSchema.safeParse({
        requestId: REQUEST_ID,
        status: "rejected",
        resolutionCode: "x",
      }).success,
    ).toBe(true);
  });
});
