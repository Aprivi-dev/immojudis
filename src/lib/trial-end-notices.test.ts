import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  update: vi.fn(),
  profiles: vi.fn(),
  readUserEmail: vi.fn(),
  send: vi.fn(),
  build: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: (table: string) => {
      if (table === "user_profiles") {
        return { select: () => ({ eq: () => mocks.profiles() }) };
      }
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: (_column: string, userId: string) => ({
            eq: async (_column2: string, endsOn: string) => {
              mocks.update(table, patch, userId, endsOn);
              return { error: null };
            },
          }),
        }),
      };
    },
  },
}));
vi.mock("@/lib/email-alerts", () => ({
  readUserEmail: mocks.readUserEmail,
  sendResendEmail: mocks.send,
  resolveEmailAlertDeliveryConfig: () => config,
}));
vi.mock("@/lib/trial-end-email", () => ({ buildTrialEndMessage: mocks.build }));

import {
  assertTrialEndNoticesComplete,
  runTrialEndNotices,
  type TrialEndNoticeSummary,
} from "./trial-end-notices";

const config = {
  configured: true,
  apiKey: "re_test",
  from: "Immojudis <compte@immojudis.test>",
  appUrl: "https://immojudis.test",
  missing: [],
};
const now = new Date("2026-11-09T12:30:00Z");
const A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const B = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

function queue(...ids: string[]) {
  return {
    data: {
      needs_review: 1,
      recipients: ids.map((id) => ({
        user_id: id,
        ends_at: "2026-11-11T08:00:00Z",
        ends_on: "2026-11-11",
      })),
    },
    error: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.readUserEmail.mockResolvedValue("claire@example.test");
  mocks.build.mockImplementation(async (args: Record<string, unknown>) => ({
    to: args.recipientEmail,
    subject: "Objet",
    html: "<p>x</p>",
    text: "x",
    unsubscribeUrl: "https://immojudis.test/u",
    oneClickUnsubscribe: true,
  }));
  mocks.send.mockResolvedValue({ id: "msg-1" });
  mocks.rpc.mockImplementation(async (name: string) =>
    name === "claim_launch_offer_end_notice" ? { data: true, error: null } : queue(A, B),
  );
});

const run = (overrides: Parameters<typeof runTrialEndNotices>[0] = {}) =>
  runTrialEndNotices({ now, fetchImpl: vi.fn() as unknown as typeof fetch, config, ...overrides });

describe("runTrialEndNotices", () => {
  it("n'envoie rien, ne lit rien, en mode off (défaut)", async () => {
    const summary = await run({ mode: "off" });
    expect(summary).toMatchObject({ mode: "off", due: 0, sent: 0, failed: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("réserve puis envoie chaque message dû, et le note dans le journal", async () => {
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ mode: "on", due: 2, sent: 2, failed: 0, needsReview: 1 });
    expect(mocks.rpc).toHaveBeenCalledWith("get_trial_end_notice_queue", {
      p_limit: 200,
      p_now: now.toISOString(),
    });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_launch_offer_end_notice", {
      p_user_id: A,
      p_ends_on: "2026-11-11",
      p_now: now.toISOString(),
    });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      apiKey: "re_test",
      idempotencyKey: `immojudis-launch-offer-end-${A}-2026-11-11`,
      category: "launch_offer_end",
    });
    expect(mocks.build.mock.calls[0][0]).toMatchObject({ userId: A, internal: false });
    expect(mocks.update).toHaveBeenCalledWith(
      "launch_offer_end_notices",
      expect.objectContaining({ status: "sent", message_id: "msg-1" }),
      A,
      "2026-11-11",
    );
  });

  it("ne réécrit pas un compte déjà réservé ou désinscrit entre-temps", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "claim_launch_offer_end_notice" ? { data: false, error: null } : queue(A),
    );
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ due: 1, sent: 0, skipped: 1, failed: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("note un échec d'envoi sans bloquer les autres comptes", async () => {
    mocks.send
      .mockRejectedValueOnce(new Error("Resend a refusé"))
      .mockResolvedValueOnce({ id: "m2" });
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ sent: 1, failed: 1 });
    expect(mocks.update).toHaveBeenCalledWith(
      "launch_offer_end_notices",
      expect.objectContaining({ status: "failed", error: "send_failed" }),
      A,
      "2026-11-11",
    );
    expect(() => assertTrialEndNoticesComplete(summary)).toThrow(/1 envoi\(s\) en échec/);
  });

  it("note une adresse indisponible, sans rien envoyer", async () => {
    mocks.readUserEmail.mockResolvedValue(null);
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ sent: 0, failed: 2 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      "launch_offer_end_notices",
      expect.objectContaining({ status: "failed", error: "email_unavailable" }),
      A,
      "2026-11-11",
    );
  });

  it("échoue quand un envoi est dû et que Resend n'est pas configuré, sans réserver personne", async () => {
    const summary = await run({
      mode: "on",
      config: { ...config, configured: false, apiKey: null, missing: ["RESEND_API_KEY"] },
    });
    expect(summary).toMatchObject({ due: 2, sent: 0, configured: false });
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_launch_offer_end_notice", expect.anything());
    expect(() => assertTrialEndNoticesComplete(summary)).toThrow(/Resend n'est pas configuré/);
  });

  it("réussit sans configuration quand rien n'est dû", async () => {
    mocks.rpc.mockResolvedValue({ data: { recipients: [] }, error: null });
    const summary = await run({
      mode: "on",
      config: { ...config, configured: false, apiKey: null, missing: ["RESEND_API_KEY"] },
    });
    expect(summary.due).toBe(0);
    expect(summary.configured).toBe(true);
    expect(() => assertTrialEndNoticesComplete(summary)).not.toThrow();
  });

  it("s'arrête de lui-même au bout de son délai et le dit", async () => {
    const summary = await run({ mode: "on", budgetMs: -1 });
    expect(summary).toMatchObject({ sent: 0, interrupted: true });
    expect(() => assertTrialEndNoticesComplete(summary)).toThrow(/interrompu/);
  });

  it("lève quand la file est illisible", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(run({ mode: "on" })).rejects.toMatchObject({ code: "XX000" });
  });

  it("en mode internal, n'écrit qu'aux administrateurs, une fois par jour, objet d'essai", async () => {
    mocks.profiles.mockResolvedValue({ data: [{ user_id: A }], error: null });
    const summary = await run({ mode: "internal" });
    expect(summary).toMatchObject({ mode: "internal", due: 1, sent: 1 });
    expect(mocks.rpc).not.toHaveBeenCalledWith("get_trial_end_notice_queue", expect.anything());
    expect(mocks.rpc).toHaveBeenCalledWith("claim_launch_offer_end_notice", {
      p_user_id: A,
      p_ends_on: "2026-11-09",
      p_now: now.toISOString(),
    });
    expect(mocks.build.mock.calls[0][0]).toMatchObject({ userId: A, internal: true });
  });
});

describe("assertTrialEndNoticesComplete", () => {
  const ok: TrialEndNoticeSummary = {
    mode: "on",
    due: 1,
    sent: 1,
    failed: 0,
    skipped: 0,
    needsReview: 0,
    configured: true,
    interrupted: false,
  };

  it("laisse passer un passage complet, ou fermé", () => {
    expect(() => assertTrialEndNoticesComplete(ok)).not.toThrow();
    expect(() =>
      assertTrialEndNoticesComplete({ ...ok, mode: "off", due: 0, sent: 0 }),
    ).not.toThrow();
  });
});
