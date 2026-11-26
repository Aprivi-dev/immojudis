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
          eq: async (_column: string, userId: string) => {
            mocks.update(table, patch, userId);
            return { error: null };
          },
        }),
      };
    },
  },
}));
vi.mock("@/lib/email-alerts", () => ({
  readUserEmail: mocks.readUserEmail,
  resolveNoReplyEmailConfig: () => config,
}));
vi.mock("@/lib/send-tracked-email", () => ({ sendTrackedEmail: mocks.send }));
vi.mock("@/lib/onboarding-email", () => ({ buildOnboardingMessage: mocks.build }));

import {
  assertOnboardingEmailsComplete,
  runOnboardingEmails,
  type OnboardingEmailSummary,
} from "./onboarding-email-notices";

const config = {
  configured: true,
  apiKey: "re_test",
  from: "Immojudis <compte@immojudis.test>",
  appUrl: "https://immojudis.test",
  missing: [],
};
const now = new Date("2026-11-27T13:30:00Z");
const A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const B = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

function queue(...rows: Array<[string, string | null]>) {
  return {
    data: {
      needs_review: 1,
      recipients: rows.map(([id, department]) => ({ user_id: id, department })),
    },
    error: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.readUserEmail.mockResolvedValue("claire@example.test");
  mocks.build.mockImplementation((args: Record<string, unknown>) => ({
    to: args.recipientEmail,
    subject: "Objet",
    html: "<p>x</p>",
    text: "x",
    unsubscribeUrl: "https://immojudis.test/u",
    oneClickUnsubscribe: true,
  }));
  mocks.send.mockResolvedValue({ id: "msg-1" });
  mocks.rpc.mockImplementation(async (name: string) =>
    name === "claim_onboarding_email" ? { data: true, error: null } : queue([A, "33"], [B, null]),
  );
});

const run = (overrides: Parameters<typeof runOnboardingEmails>[0] = {}) =>
  runOnboardingEmails({ now, fetchImpl: vi.fn() as unknown as typeof fetch, config, ...overrides });

describe("runOnboardingEmails", () => {
  it("n'envoie rien et ne lit rien en mode off (défaut)", async () => {
    const summary = await run({ mode: "off" });
    expect(summary).toMatchObject({ mode: "off", due: 0, sent: 0, failed: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.profiles).not.toHaveBeenCalled();
    expect(mocks.readUserEmail).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("réserve AVANT d'envoyer, envoie une fois par compte et le note au journal", async () => {
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ mode: "on", due: 2, sent: 2, failed: 0, needsReview: 1 });
    expect(mocks.rpc).toHaveBeenCalledWith("get_onboarding_email_queue", {
      p_limit: 200,
      p_now: now.toISOString(),
    });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_onboarding_email", {
      p_user_id: A,
      p_now: now.toISOString(),
    });
    const claimOrder = mocks.rpc.mock.invocationCallOrder[1];
    expect(claimOrder).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      apiKey: "re_test",
      idempotencyKey: `immojudis-onboarding-${A}`,
      category: "onboarding",
      templateKey: "onboarding",
      mode: "on",
      userId: A,
    });
    expect(mocks.build.mock.calls[0][0]).toMatchObject({
      userId: A,
      department: "33",
      internal: false,
    });
    expect(mocks.build.mock.calls[1][0]).toMatchObject({ userId: B, department: null });
    expect(mocks.update).toHaveBeenCalledWith(
      "onboarding_email_notices",
      expect.objectContaining({ status: "sent", message_id: "msg-1" }),
      A,
    );
  });

  it("n'écrit pas à un compte déjà réservé, désinscrit ou sorti de l'audience entre-temps", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "claim_onboarding_email" ? { data: false, error: null } : queue([A, "33"]),
    );
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ due: 1, sent: 0, skipped: 1, failed: 0 });
    expect(mocks.readUserEmail).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("note un échec d'envoi sans bloquer les autres comptes", async () => {
    mocks.send
      .mockRejectedValueOnce(new Error("Resend a refusé"))
      .mockResolvedValueOnce({ id: "m2" });
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ sent: 1, failed: 1 });
    expect(mocks.update).toHaveBeenCalledWith(
      "onboarding_email_notices",
      expect.objectContaining({ status: "failed", error: "send_failed" }),
      A,
    );
    expect(() => assertOnboardingEmailsComplete(summary)).toThrow(/1 of 2 sends failed/);
  });

  it("note une adresse indisponible, sans rien envoyer", async () => {
    mocks.readUserEmail.mockResolvedValue(null);
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ sent: 0, failed: 2 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      "onboarding_email_notices",
      expect.objectContaining({ status: "failed", error: "email_unavailable" }),
      A,
    );
  });

  it("garde le compte dû quand la réservation échoue", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "claim_onboarding_email"
        ? { data: null, error: { code: "XX000", message: "boom" } }
        : queue([A, null]),
    );
    const summary = await run({ mode: "on" });
    expect(summary).toMatchObject({ due: 1, sent: 0, failed: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("échoue quand un envoi est dû et que Resend n'est pas configuré, sans réserver personne", async () => {
    const summary = await run({
      mode: "on",
      config: { ...config, configured: false, apiKey: null, missing: ["RESEND_API_KEY"] },
    });
    expect(summary).toMatchObject({ due: 2, sent: 0, configured: false });
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_onboarding_email", expect.anything());
    expect(() => assertOnboardingEmailsComplete(summary)).toThrow(/Resend n'est pas configuré/);
  });

  it("réussit sans configuration quand rien n'est dû", async () => {
    mocks.rpc.mockResolvedValue({ data: { recipients: [] }, error: null });
    const summary = await run({
      mode: "on",
      config: { ...config, configured: false, apiKey: null, missing: ["RESEND_API_KEY"] },
    });
    expect(summary.due).toBe(0);
    expect(summary.configured).toBe(true);
    expect(() => assertOnboardingEmailsComplete(summary)).not.toThrow();
  });

  it("s'arrête de lui-même au bout de son délai et le dit", async () => {
    const summary = await run({ mode: "on", budgetMs: -1 });
    expect(summary).toMatchObject({ sent: 0, interrupted: true });
    expect(() => assertOnboardingEmailsComplete(summary)).toThrow(/stopped by its time budget/);
  });

  it("lève quand la file est illisible", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(run({ mode: "on" })).rejects.toMatchObject({ code: "XX000" });
  });

  it("ignore une ligne de file mal formée", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "claim_onboarding_email"
        ? { data: true, error: null }
        : {
            data: { recipients: [{ user_id: A, department: 33 }, { department: "33" }] },
            error: null,
          },
    );
    const summary = await run({ mode: "on" });
    expect(summary.due).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("en mode internal, n'écrit qu'aux administrateurs, sans lire la file ni écrire le journal", async () => {
    mocks.profiles.mockResolvedValue({ data: [{ user_id: A }], error: null });
    const summary = await run({ mode: "internal" });
    expect(summary).toMatchObject({ mode: "internal", due: 1, sent: 1 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.build.mock.calls[0][0]).toMatchObject({
      userId: A,
      department: null,
      internal: true,
    });
    // Un exemple par administrateur et par jour : la clé d'idempotence est datée.
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      idempotencyKey: `immojudis-onboarding-internal-${A}-2026-11-27`,
      mode: "internal",
      category: "onboarding",
    });
  });
});

describe("assertOnboardingEmailsComplete", () => {
  const ok: OnboardingEmailSummary = {
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
    expect(() => assertOnboardingEmailsComplete(ok)).not.toThrow();
    expect(() =>
      assertOnboardingEmailsComplete({ ...ok, mode: "off", due: 0, sent: 0 }),
    ).not.toThrow();
  });
});
