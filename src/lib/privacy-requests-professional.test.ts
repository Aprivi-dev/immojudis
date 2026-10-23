import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "99999999-9999-4999-8999-999999999999";

const state = vi.hoisted(() => ({
  requestRow: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  erase: vi.fn(),
  collect: vi.fn(),
  deleteUser: vi.fn(),
  stripeDel: vi.fn(),
}));

vi.mock("@/lib/billing", () => ({ getStripe: () => ({ customers: { del: state.stripeDel } }) }));
vi.mock("@/lib/information-agent-professional-rights", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent-professional-rights")>()),
  eraseProfessionalData: state.erase,
  collectProfessionalData: state.collect,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { admin: { deleteUser: state.deleteUser } },
    from() {
      let payload: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (value: Record<string, unknown>) => {
          payload = value;
          return builder;
        },
        eq: () => builder,
        single: async () => {
          if (payload) {
            state.updates.push(payload);
            return { data: { ...state.requestRow, ...payload }, error: null };
          }
          return { data: state.requestRow, error: null };
        },
      };
      return builder;
    },
  },
}));

import { executePrivacyErasure, exportProfessionalPrivacyData } from "./privacy-requests";

const admin = { userId: ADMIN_ID, isAdmin: true } as unknown as SupabaseAuthContext;
const input = { requestId: REQUEST_ID, confirmEmail: "Maitre@Cabinet.example" };

function professionalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    request_type: "erasure",
    status: "received",
    identity_status: "verified",
    message: null,
    submitted_at: "2026-10-01T10:00:00.000Z",
    acknowledged_at: "2026-10-01T10:00:00.000Z",
    due_at: "2026-11-01T10:00:00.000Z",
    completed_at: null,
    resolution_code: null,
    requester_email: "maitre@cabinet.example",
    user_id: null,
    operator_notes: null,
    metadata: { source: "information_agent_professional_link" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  state.requestRow = professionalRequest();
  state.updates = [];
  state.erase.mockResolvedValue({
    deletedRows: { information_agent_cases: 2, information_agent_missions: 3 },
    storageObjectsQueued: 4,
    oppositionRecorded: true,
  });
  state.collect.mockResolvedValue({ email: "maitre@cabinet.example", cases: [] });
});

describe("effacement d'un professionnel sans compte", () => {
  it("efface les données de l'agent par l'adresse, sans compte ni client Stripe, puis clôt la demande", async () => {
    const report = await executePrivacyErasure({ auth: admin, input });

    expect(state.erase).toHaveBeenCalledWith("maitre@cabinet.example");
    expect(state.deleteUser).not.toHaveBeenCalled();
    expect(state.stripeDel).not.toHaveBeenCalled();
    expect(state.updates[0]).toMatchObject({
      status: "completed",
      resolution_code: "information_agent_professional_erasure_executed",
    });
    expect(report).toMatchObject({
      stripeCustomerDeleted: false,
      authUserDeleted: false,
      storageObjectsRemoved: 4,
      deletedRows: { information_agent_cases: 2, information_agent_missions: 3 },
    });
    expect(report.request.subjectKind).toBe("information_agent_professional");
  });

  it("exige que l'administrateur retape l'adresse du demandeur", async () => {
    await expect(
      executePrivacyErasure({
        auth: admin,
        input: { ...input, confirmEmail: "autre@cabinet.example" },
      }),
    ).rejects.toThrow("ne correspond pas");
    expect(state.erase).not.toHaveBeenCalled();
  });

  it("exige une identité vérifiée et une demande ouverte", async () => {
    state.requestRow = professionalRequest({ identity_status: "authenticated" });
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
      "Vérifiez l'identité",
    );
    state.requestRow = professionalRequest({ status: "completed" });
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow("déjà clôturée");
    expect(state.erase).not.toHaveBeenCalled();
  });

  it("ne traite pas comme professionnelle une demande sans compte d'une autre origine", async () => {
    state.requestRow = professionalRequest({ metadata: {} });
    await expect(executePrivacyErasure({ auth: admin, input })).rejects.toThrow(
      "Le compte de ce demandeur n'existe plus.",
    );
    expect(state.erase).not.toHaveBeenCalled();
  });
});

describe("export des données d'un professionnel", () => {
  it("réserve l'export aux administrateurs et aux demandes d'accès de professionnels vérifiés", async () => {
    state.requestRow = professionalRequest({ request_type: "access" });

    await expect(
      exportProfessionalPrivacyData({
        auth: { userId: "u", isAdmin: false } as unknown as SupabaseAuthContext,
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      exportProfessionalPrivacyData({ auth: admin, requestId: REQUEST_ID }),
    ).resolves.toMatchObject({ email: "maitre@cabinet.example" });
    expect(state.collect).toHaveBeenCalledWith("maitre@cabinet.example");

    state.requestRow = professionalRequest({ request_type: "erasure" });
    await expect(
      exportProfessionalPrivacyData({ auth: admin, requestId: REQUEST_ID }),
    ).rejects.toThrow("pas une demande d'accès");
    state.requestRow = professionalRequest({ request_type: "access", user_id: "some-user" });
    await expect(
      exportProfessionalPrivacyData({ auth: admin, requestId: REQUEST_ID }),
    ).rejects.toThrow("pas une demande d'accès");
  });
});
