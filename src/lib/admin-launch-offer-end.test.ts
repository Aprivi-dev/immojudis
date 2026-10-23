import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserById: vi.fn(),
  rpc: vi.fn(),
  update: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder = {
        update: (patch: Record<string, unknown>) => {
          mocks.update(table, patch, filters);
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        then: (ok: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      };
      return builder;
    },
    auth: { admin: { getUserById: mocks.getUserById } },
  },
}));
vi.mock("@/lib/email-alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-alerts")>()),
  sendResendEmail: mocks.send,
}));

import {
  buildLaunchOfferEndMessage,
  getAdminLaunchOfferEnd,
  launchOfferEndActionSchema,
  launchOfferEndIdempotencyKey,
  launchOfferEndUnsubscribeUrl,
  sendLaunchOfferEndBatch,
  sendLaunchOfferEndTest,
  setAdminLaunchOfferEnd,
} from "@/lib/admin-launch-offer-end";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";

const env = {
  RESEND_API_KEY: "re_test",
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.test>",
  SITE_URL: "https://immojudis.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
} as unknown as Pick<NodeJS.ProcessEnv, string>;

const NOW = new Date("2026-10-23T09:00:00.000Z");
const ENDS_ON = "2026-12-01"; // 39 jours plus tard
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Database = {
  config?: { active: boolean; ends_on: string | null };
  recipients?: string[];
  claimed?: (userId: string) => boolean;
  missing?: boolean;
};

function database({
  config = { active: true, ends_on: ENDS_ON },
  recipients = [],
  claimed = () => true,
  missing = false,
}: Database = {}) {
  let remaining = recipients.length;
  mocks.rpc.mockImplementation(async (fn: string, params: Record<string, unknown>) => {
    if (missing) return { data: null, error: { code: "PGRST202", message: "missing" } };
    if (fn === "get_launch_offer_config") return { data: config, error: null };
    if (fn === "get_launch_offer_end_queue") {
      return {
        data: {
          audience: 10,
          opted_out: 1,
          notified: 2,
          total: remaining,
          in_progress: 0,
          needs_review: 1,
          recipients: recipients.slice(0, Number(params.p_limit)),
        },
        error: null,
      };
    }
    if (fn === "claim_launch_offer_end_notice") {
      const ok = claimed(String(params.p_user_id));
      if (ok) remaining -= 1;
      return { data: ok, error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue({ userId: idOf(999), isAdmin: true });
  mocks.getUserById.mockImplementation(async (id: string) => ({
    data: { user: { email: `${id}@exemple.test`, email_confirmed_at: "2026-01-01T00:00:00Z" } },
    error: null,
  }));
  mocks.send.mockResolvedValue({ id: "resend-1" });
});

describe("launchOfferEndActionSchema", () => {
  it("n'accepte un envoi réel qu'avec la confirmation et la date affichée", () => {
    expect(
      launchOfferEndActionSchema.safeParse({ action: "send", confirm: true, endsOn: ENDS_ON })
        .success,
    ).toBe(true);
    expect(launchOfferEndActionSchema.safeParse({ action: "send", endsOn: ENDS_ON }).success).toBe(
      false,
    );
    expect(launchOfferEndActionSchema.safeParse({ action: "send", confirm: true }).success).toBe(
      false,
    );
    expect(
      launchOfferEndActionSchema.safeParse({ action: "send", confirm: false, endsOn: ENDS_ON })
        .success,
    ).toBe(false);
    expect(
      launchOfferEndActionSchema.safeParse({
        action: "send",
        confirm: true,
        endsOn: ENDS_ON,
        limit: 201,
      }).success,
    ).toBe(false);
  });

  it("valide la date (un jour qui existe) ou l'effacement", () => {
    expect(launchOfferEndActionSchema.safeParse({ action: "set-date", endsOn: null }).success).toBe(
      true,
    );
    expect(
      launchOfferEndActionSchema.safeParse({ action: "set-date", endsOn: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      launchOfferEndActionSchema.safeParse({ action: "set-date", endsOn: "demain" }).success,
    ).toBe(false);
    expect(launchOfferEndActionSchema.safeParse({ action: "test", extra: 1 }).success).toBe(false);
  });
});

describe("buildLaunchOfferEndMessage", () => {
  it("annonce la date, avec un lien de désinscription signé en un clic", async () => {
    const unsubscribeUrl = launchOfferEndUnsubscribeUrl({
      appUrl: "https://immojudis.test",
      userId: idOf(1),
      now: NOW,
      env,
    });
    const message = await buildLaunchOfferEndMessage({
      recipientEmail: "a@exemple.test",
      from: "Immojudis <alertes@immojudis.test>",
      appUrl: "https://immojudis.test",
      endsOn: ENDS_ON,
      unsubscribeUrl,
    });

    expect(message.subject).toBe(
      "Immojudis : fin de l’offre de lancement prévue le 1 décembre 2026",
    );
    expect(message.text).toContain("1 décembre 2026");
    expect(message.oneClickUnsubscribe).toBe(true);
    expect(message.html).toContain("https://immojudis.test/compte");
    const token = new URL(unsubscribeUrl).searchParams.get("token");
    expect(verifyUnsubscribeToken(token, { now: NOW, env })).toMatchObject({
      userId: idOf(1),
      scope: { kind: "launch-offer-end" },
    });
  });
});

describe("getAdminLaunchOfferEnd", () => {
  it("rend la date, les comptes concernés et l'aperçu, sans adresse", async () => {
    database({ recipients: [idOf(1), idOf(2)] });
    const state = await getAdminLaunchOfferEnd({ authToken: "t", now: NOW, env });

    expect(state).toMatchObject({
      active: true,
      endsOn: ENDS_ON,
      endsOnLabel: "1 décembre 2026",
      daysLeft: 39,
      blocker: null,
      audience: { accounts: 10, optedOut: 1, notified: 2, recipients: 2, needsReview: 1 },
      configured: true,
    });
    expect(state.preview?.text).toContain("1 décembre 2026");
    expect(JSON.stringify(state)).not.toContain("@exemple.test");
  });

  it("bloque l'envoi sous 30 jours, sans date, ou une fois l'offre coupée", async () => {
    database({ config: { active: true, ends_on: "2026-11-10" } });
    expect((await getAdminLaunchOfferEnd({ authToken: "t", now: NOW, env })).blocker).toMatch(
      /au moins 30 jours/,
    );

    database({ config: { active: true, ends_on: null } });
    const none = await getAdminLaunchOfferEnd({ authToken: "t", now: NOW, env });
    expect(none).toMatchObject({ endsOn: null, audience: null, preview: null });
    expect(none.blocker).toMatch(/Enregistrez d’abord/);

    database({ config: { active: false, ends_on: ENDS_ON } });
    expect((await getAdminLaunchOfferEnd({ authToken: "t", now: NOW, env })).blocker).toMatch(
      /déjà coupée/,
    );
  });

  it("dit que la migration manque, sans planter, et refuse un non-administrateur", async () => {
    database({ missing: true });
    await expect(getAdminLaunchOfferEnd({ authToken: "t", now: NOW, env })).rejects.toMatchObject({
      status: 503,
    });

    mocks.auth.mockResolvedValue({ userId: idOf(5), isAdmin: false });
    await expect(getAdminLaunchOfferEnd({ authToken: "t", now: NOW, env })).rejects.toThrow(
      "Forbidden",
    );
  });
});

describe("setAdminLaunchOfferEnd", () => {
  it("enregistre la date avec l'administrateur, sans toucher à l'état de l'offre", async () => {
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    await setAdminLaunchOfferEnd({ authToken: "t", endsOn: ENDS_ON });

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("set_launch_offer_end", {
      p_ends_on: ENDS_ON,
      p_actor: idOf(999),
    });
  });

  it("traduit le refus d'une date passée", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "past" } });
    await expect(
      setAdminLaunchOfferEnd({ authToken: "t", endsOn: "2026-01-01" }),
    ).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe("sendLaunchOfferEndBatch", () => {
  const send = (overrides: Partial<Parameters<typeof sendLaunchOfferEndBatch>[0]> = {}) =>
    sendLaunchOfferEndBatch({ authToken: "t", endsOn: ENDS_ON, now: NOW, env, ...overrides });

  it("réserve puis envoie à chaque destinataire, avec une clé d'idempotence par compte et par date", async () => {
    database({ recipients: [idOf(1), idOf(2)] });
    const result = await send();

    expect(result).toEqual({ sent: 2, failed: 0, skipped: 0, remaining: 0, stoppedEarly: false });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const keys = mocks.send.mock.calls.map(([call]) => call.idempotencyKey).sort();
    expect(keys).toEqual([
      launchOfferEndIdempotencyKey(idOf(1), ENDS_ON),
      launchOfferEndIdempotencyKey(idOf(2), ENDS_ON),
    ]);
    const message = mocks.send.mock.calls[0][0].message;
    expect(message.to).toMatch(/@exemple\.test$/);
    expect(message.unsubscribeUrl).toContain("/api/notification-preferences/unsubscribe?token=");
    // Le journal garde l'état, jamais le contenu.
    expect(mocks.update).toHaveBeenCalledWith(
      "launch_offer_end_notices",
      expect.objectContaining({ status: "sent", message_id: "resend-1" }),
      { user_id: expect.any(String), ends_on: ENDS_ON },
    );
  });

  it("n'envoie pas deux fois : un préavis déjà réservé est ignoré", async () => {
    database({ recipients: [idOf(1), idOf(2)], claimed: (id) => id !== idOf(1) });
    const result = await send();

    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].message.to).toContain(idOf(2));
  });

  it("marque un échec d'envoi pour pouvoir le reprendre, sans arrêter les autres", async () => {
    database({ recipients: [idOf(1), idOf(2)] });
    mocks.send.mockRejectedValueOnce(new Error("Resend a refusé")).mockResolvedValue({ id: "ok" });
    const result = await send();

    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(mocks.update).toHaveBeenCalledWith(
      "launch_offer_end_notices",
      expect.objectContaining({ status: "failed", error: "send_failed" }),
      expect.anything(),
    );
  });

  it("n'écrit pas à une adresse non confirmée", async () => {
    database({ recipients: [idOf(1)] });
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "x@exemple.test", email_confirmed_at: null } },
      error: null,
    });
    const result = await send();

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("ne part pas si la date a changé depuis l'écran, ni sous 30 jours, ni offre coupée, ni non configuré", async () => {
    database({ recipients: [idOf(1)] });
    await expect(send({ endsOn: "2026-12-15" })).rejects.toMatchObject({ status: 409 });

    database({ config: { active: true, ends_on: "2026-11-10" }, recipients: [idOf(1)] });
    await expect(send({ endsOn: "2026-11-10" })).rejects.toMatchObject({ status: 409 });

    database({ config: { active: false, ends_on: ENDS_ON }, recipients: [idOf(1)] });
    await expect(send()).rejects.toMatchObject({ status: 409 });

    database({ recipients: [idOf(1)] });
    await expect(send({ env: {} as never })).rejects.toMatchObject({ status: 503 });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_launch_offer_end_notice", expect.anything());
  });

  it("refuse un non-administrateur sans rien lire", async () => {
    mocks.auth.mockResolvedValue({ userId: idOf(5), isAdmin: false });
    await expect(send()).rejects.toThrow("Forbidden");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("s'arrête au budget de temps et dit qu'il reste des destinataires", async () => {
    database({ recipients: [idOf(1), idOf(2), idOf(3)] });
    let ticks = 0;
    const result = await send({ clock: () => (ticks++ === 0 ? 0 : 60_000) });

    expect(result.stoppedEarly).toBe(true);
    expect(result.sent).toBe(0);
  });
});

describe("sendLaunchOfferEndTest", () => {
  it("envoie l'essai à l'administrateur seul, sans réserver ni journaliser de préavis", async () => {
    database({});
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "admin@immojudis.test", email_confirmed_at: "2026-01-01" } },
      error: null,
    });
    const result = await sendLaunchOfferEndTest({ authToken: "t", now: NOW, env });

    expect(result).toEqual({ sentTo: "admin@immojudis.test" });
    expect(mocks.send.mock.calls[0][0].message.subject).toMatch(/^\[Test\] /);
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_launch_offer_end_notice", expect.anything());
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("demande d'abord une date", async () => {
    database({ config: { active: true, ends_on: null } });
    await expect(sendLaunchOfferEndTest({ authToken: "t", env })).rejects.toMatchObject({
      status: 409,
    });
  });
});
