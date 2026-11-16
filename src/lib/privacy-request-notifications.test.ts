import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@/integrations/supabase/types";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  openRows: [] as Array<Record<string, unknown>>,
  closingRows: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/lib/send-tracked-email", () => ({ sendTrackedEmail: state.send }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: state.rpc,
    from() {
      let mode: "select" | "update" = "select";
      let payload: Record<string, unknown> = {};
      let closing = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (value: Record<string, unknown>) => {
          mode = "update";
          payload = value;
          return builder;
        },
        eq: (column: string) => {
          if (column === "metadata->notifications->closure->>status") closing = true;
          if (mode === "update") {
            state.updates.push(payload);
            state.metadata = payload.metadata as Record<string, unknown>;
            return Promise.resolve({ error: null });
          }
          return builder;
        },
        in: () => builder,
        order: () => builder,
        limit: () =>
          Promise.resolve({
            data: closing ? state.closingRows : state.openRows,
            error: null,
          }),
        single: async () => ({ data: { metadata: state.metadata }, error: null }),
      };
      return builder;
    },
  },
}));

import {
  followUpPrivacyRequests,
  notifyPrivacyRequestClosed,
  notifyPrivacyRequestReceived,
  withPendingClosure,
} from "./privacy-request-notifications";

const ENV = {
  RESEND_API_KEY: "re_test",
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.test>",
  TRANSACTIONAL_EMAIL_FROM: "Immojudis <compte@immojudis.test>",
  SITE_URL: "https://immojudis.test",
  OPERATIONS_ALERT_EMAIL_TO: "proprietaire@immojudis.test",
};

function row(metadata: Json = { source: "authenticated_rights_portal" }) {
  return {
    id: REQUEST_ID,
    request_type: "erasure",
    requester_email: "client@example.test",
    user_id: USER_ID,
    submitted_at: "2026-11-15T09:00:00Z",
    due_at: "2026-12-15T09:00:00Z",
    status: "received",
    metadata,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.metadata = { source: "authenticated_rights_portal" };
  state.updates = [];
  state.openRows = [];
  state.closingRows = [];
  state.send.mockResolvedValue({ id: "re_email" });
  state.rpc.mockResolvedValue({ data: { due_soon: 0, overdue: 1 }, error: null });
});

describe("notifyPrivacyRequestReceived (E1, E2)", () => {
  it("prévient l'exploitation sans données du demandeur et envoie l'accusé, dont l'envoi date acknowledged_at", async () => {
    const outcome = await notifyPrivacyRequestReceived(row(), { env: ENV });

    expect(outcome).toEqual({ operator: "sent", acknowledgement: "sent" });
    const operator = state.send.mock.calls.find(
      ([input]) => input.templateKey === "privacy_request_operator",
    )?.[0];
    expect(operator).toMatchObject({
      category: "operations",
      message: { to: "proprietaire@immojudis.test", from: "Immojudis <alertes@immojudis.test>" },
    });
    expect(JSON.stringify(operator.message)).not.toContain("client@example.test");
    const ack = state.send.mock.calls.find(
      ([input]) => input.templateKey === "privacy_request_acknowledgement",
    )?.[0];
    expect(ack).toMatchObject({
      category: "privacy",
      userId: USER_ID,
      idempotencyKey: `privacy-request-ack-${REQUEST_ID}`,
      message: { to: "client@example.test", from: "Immojudis <compte@immojudis.test>" },
    });
    const ackUpdate = state.updates.find((update) => "acknowledged_at" in update);
    expect(ackUpdate?.acknowledged_at).toEqual(expect.any(String));
    expect(state.metadata).toMatchObject({
      source: "authenticated_rights_portal",
      notifications: {
        operator: { status: "sent", attempts: 1 },
        acknowledgement: { status: "sent", email_id: "re_email" },
      },
    });
  });

  it("ne lève jamais : un échec d'envoi est compté et reste à reprendre", async () => {
    state.send.mockRejectedValue(new Error("Resend down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(notifyPrivacyRequestReceived(row(), { env: ENV })).resolves.toEqual({
      operator: "failed",
      acknowledgement: "failed",
    });
    expect(state.updates.some((update) => "acknowledged_at" in update)).toBe(false);
    expect(state.metadata).toMatchObject({
      notifications: { acknowledgement: { status: "pending", attempts: 1 } },
    });
    // Le journal ne porte ni l'adresse ni le message du demandeur.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("client@example.test");
    warn.mockRestore();
  });

  it("sans canal configuré, rien ne part et rien n'est compté (repris plus tard)", async () => {
    await expect(notifyPrivacyRequestReceived(row(), { env: {} })).resolves.toEqual({
      operator: "unconfigured",
      acknowledgement: "unconfigured",
    });
    expect(state.send).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });
});

describe("notifyPrivacyRequestClosed", () => {
  it("envoie l'email de clôture posé par la clôture, vers l'adresse de la demande, compte effacé compris", async () => {
    const metadata = withPendingClosure(
      { source: "authenticated_rights_portal" },
      {
        status: "completed",
        closedAt: "2026-11-20T09:00:00Z",
        erasureExecuted: true,
        response: null,
      },
    );
    state.metadata = metadata as Record<string, unknown>;
    const outcome = await notifyPrivacyRequestClosed(
      { ...row(metadata), user_id: null, status: "completed" },
      { env: ENV },
    );
    expect(outcome).toBe("sent");
    expect(state.send.mock.calls[0][0]).toMatchObject({
      templateKey: "privacy_request_closure",
      userId: null,
      message: { to: "client@example.test" },
    });
    expect(state.send.mock.calls[0][0].message.text).toContain("ont été effacés");
    expect(state.metadata).toMatchObject({
      notifications: {
        closure: {
          status: "sent",
          email_id: "re_email",
          template_key: "privacy_request_closure",
          erasure_executed: true,
        },
      },
    });
  });

  it("n'envoie rien pour une demande close avant ce suivi", async () => {
    await expect(
      notifyPrivacyRequestClosed({ ...row(), status: "completed" }, { env: ENV }),
    ).resolves.toBe("skipped");
    expect(state.send).not.toHaveBeenCalled();
  });
});

describe("followUpPrivacyRequests", () => {
  it("reprend les envois dus et évalue les alertes compliance.privacy_requests.*", async () => {
    state.openRows = [
      // Demande antérieure au suivi : jamais prévenue, jamais accusée.
      row(),
      // Tout est parti : rien à refaire.
      row({
        notifications: { operator: { status: "sent" }, acknowledgement: { status: "sent" } },
      }),
      // Échecs épuisés : on n'insiste plus (l'alerte prend le relais).
      row({
        notifications: {
          operator: { status: "failed", attempts: 5 },
          acknowledgement: { status: "failed", attempts: 5 },
        },
      }),
    ];
    const now = new Date("2026-12-09T09:00:00Z");
    const summary = await followUpPrivacyRequests(now, { env: ENV });

    expect(summary.operator).toMatchObject({ sent: 1, skipped: 2 });
    expect(summary.acknowledgement).toMatchObject({ sent: 1, skipped: 2 });
    expect(state.rpc).toHaveBeenCalledWith("evaluate_privacy_request_health", {
      p_now: now.toISOString(),
    });
    expect(summary.evaluation).toEqual({ due_soon: 0, overdue: 1 });
  });

  it("avant la migration, l'évaluation attend sans faire échouer le passage", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } });
    await expect(followUpPrivacyRequests(new Date(), { env: ENV })).resolves.toMatchObject({
      evaluation: "migration_pending",
    });
  });

  it("toute autre erreur de la base fait échouer le passage (supervision)", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(followUpPrivacyRequests(new Date(), { env: ENV })).rejects.toMatchObject({
      message: "boom",
    });
  });
});
