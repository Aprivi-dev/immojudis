import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Call = [string, unknown[]];

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserById: vi.fn(),
  resolve: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mocks.from(table);
      const calls: Call[] = [];
      const builder: unknown = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "then") {
              return (ok: (value: unknown) => unknown, ko: (reason: unknown) => unknown) =>
                Promise.resolve(mocks.resolve(calls)).then(ok, ko);
            }
            return (...args: unknown[]) => {
              calls.push([String(property), args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
    rpc: mocks.rpc,
    auth: { admin: { getUserById: mocks.getUserById } },
  },
}));
// Le vrai module envoie par fetch : on garde sa construction de message et ses réglages.
vi.mock("@/lib/email-alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-alerts")>()),
  sendResendEmail: mocks.send,
}));

import {
  OFFER_OPENING_BATCH_SIZE,
  buildOfferOpeningMessage,
  getOfferOpeningAudience,
  offerOpeningNotifierActionSchema,
  offerOpeningUnsubscribeUrl,
  sendOfferOpeningBatch,
  sendOfferOpeningTest,
} from "@/lib/admin-offer-opening-notifier";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";

const env = {
  RESEND_API_KEY: "re_test",
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.test>",
  SITE_URL: "https://immojudis.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
} as unknown as Pick<NodeJS.ProcessEnv, string>;

const NOW = new Date("2026-10-30T09:00:00.000Z");
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const has = (calls: Call[], name: string) => calls.some(([method]) => method === name);
const args = (calls: Call[], name: string) => calls.find(([method]) => method === name)?.[1] ?? [];
const adminAuth = () => ({ userId: idOf(999), isAdmin: true });

const MISSING_FUNCTION = {
  code: "PGRST202",
  message: "Could not find the function public.get_offer_opening_queue in the schema cache",
};

/**
 * Comportement par défaut de la base simulée : `rows` à notifier, `claims` par utilisateur. La file
 * (`get_offer_opening_queue`) rend `rows` ; `rpcMissing` simule une base sans la migration
 * 20261031100300 (ancienne sélection par table). `queue` impose des entrées avec essais.
 */
function database({
  rows = [] as string[],
  claimed = (_userId: string) => true,
  recipients = rows.length,
  notified = 0,
  rpcMissing = false,
  needsReview = 0,
  queue,
}: {
  rows?: string[];
  claimed?: (userId: string) => boolean;
  recipients?: number;
  notified?: number;
  rpcMissing?: boolean;
  needsReview?: number;
  queue?: Array<{ user_id: string; attempts: number; attempted_at: string | null }>;
} = {}) {
  const updates: Array<{ patch: Record<string, unknown>; userId: string | null }> = [];
  let remaining = recipients;
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  mocks.rpc.mockImplementation(async (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    if (rpcMissing) return { data: null, error: MISSING_FUNCTION };
    const entries = queue ?? rows.map((user_id) => ({ user_id, attempts: 0, attempted_at: null }));
    return {
      data: {
        total: remaining,
        needs_review: needsReview,
        recipients: entries.slice(0, Number(params.p_limit ?? 200)),
      },
      error: null,
    };
  });
  mocks.resolve.mockImplementation((calls: Call[]) => {
    const selectOptions = args(calls, "select")[1] as { head?: boolean } | undefined;
    if (has(calls, "update")) {
      const patch = args(calls, "update")[0] as Record<string, unknown>;
      const userId = (calls.find(([method, a]) => method === "eq" && a[0] === "user_id")?.[1][1] ??
        null) as string | null;
      updates.push({ patch, userId });
      if (patch.notified_at && userId) {
        const ok = claimed(userId);
        if (ok) remaining -= 1;
        return { data: ok ? [{ user_id: userId }] : [], error: null };
      }
      remaining += 1;
      return { data: null, error: null };
    }
    if (selectOptions?.head) {
      return { count: has(calls, "not") ? notified : remaining, error: null };
    }
    return { data: rows.map((user_id) => ({ user_id })), error: null };
  });
  return { updates, rpcCalls };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Sans autre consigne, la base n'a pas la migration 20261031100300 (ancienne sélection).
  mocks.rpc.mockResolvedValue({ data: null, error: MISSING_FUNCTION });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue(adminAuth());
  mocks.send.mockResolvedValue({ id: "msg-1" });
  mocks.getUserById.mockImplementation(async (userId: string) => ({
    data: { user: { email: `${userId}@exemple.fr`, email_confirmed_at: "2026-10-01T00:00:00Z" } },
    error: null,
  }));
});

describe("message d'ouverture", () => {
  const message = buildOfferOpeningMessage({
    recipientEmail: "a@exemple.fr",
    from: "Immojudis <alertes@immojudis.test>",
    appUrl: "https://immojudis.test",
    unsubscribeUrl: "https://immojudis.test/api/notification-preferences/unsubscribe?token=abc",
  });

  it("est sobre : aucun prix, un renvoi vers /offres, Immojudis écrit sans majuscule médiane", () => {
    for (const body of [message.text, message.html, message.subject]) {
      expect(body).not.toMatch(/€|euros?|\d+\s*\/\s*mois|gratuit|offert|remise|promo/i);
      expect(body).not.toContain("ImmoJudis");
    }
    expect(message.text).toContain("https://immojudis.test/offres");
    expect(message.html).toContain('href="https://immojudis.test/offres"');
    expect(message.subject).toBe("Immojudis : l’ouverture de l’offre Analyse");
  });

  it("porte le lien de désinscription, y compris pour la désinscription en un clic", () => {
    expect(message.text).toContain("notification-preferences/unsubscribe?token=abc");
    expect(message.html).toContain("notification-preferences/unsubscribe?token=abc");
    expect(message.unsubscribeUrl).toContain("token=abc");
    expect(message.oneClickUnsubscribe).toBe(true);
  });

  it("signe le lien avec la portée « ouverture de l'offre » et le compte du destinataire", () => {
    const url = offerOpeningUnsubscribeUrl({
      appUrl: "https://immojudis.test",
      userId: idOf(1),
      now: NOW,
      env,
    });
    const token = new URL(url).searchParams.get("token");
    expect(verifyUnsubscribeToken(token, { now: NOW, env })).toMatchObject({
      userId: idOf(1),
      scope: { kind: "offer-opening" },
    });
  });

  it("marque l'envoi d'essai dans l'objet", () => {
    const internal = buildOfferOpeningMessage({
      recipientEmail: "a@exemple.fr",
      from: "x",
      appUrl: "https://immojudis.test",
      unsubscribeUrl: "u",
      internal: true,
    });
    expect(internal.subject.startsWith("[Test] ")).toBe(true);
  });
});

describe("actions acceptées", () => {
  it("n'envoie un lot que sur confirmation explicite, de 200 au plus", () => {
    const parse = (value: unknown) => offerOpeningNotifierActionSchema.safeParse(value).success;
    expect(parse({ action: "test" })).toBe(true);
    expect(parse({ action: "send", confirm: true })).toBe(true);
    expect(parse({ action: "send", confirm: true, limit: 200 })).toBe(true);
    expect(parse({ action: "send" })).toBe(false);
    expect(parse({ action: "send", confirm: false })).toBe(false);
    expect(parse({ action: "send", confirm: true, limit: 201 })).toBe(false);
    expect(parse({ action: "send", confirm: true, limit: 0 })).toBe(false);
    expect(parse({ action: "send", confirm: true, extra: 1 })).toBe(false);
    expect(parse({ action: "autre" })).toBe(false);
    expect(OFFER_OPENING_BATCH_SIZE).toBe(200);
  });
});

describe("accès administrateur", () => {
  it("refuse un compte qui n'est pas administrateur, sans rien lire ni envoyer", async () => {
    mocks.auth.mockResolvedValue({ ...adminAuth(), isAdmin: false });
    await expect(getOfferOpeningAudience({ authToken: "t", env })).rejects.toThrow("Forbidden");
    await expect(sendOfferOpeningTest({ authToken: "t", env })).rejects.toThrow("Forbidden");
    await expect(sendOfferOpeningBatch({ authToken: "t", env })).rejects.toThrow("Forbidden");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuse une session invalide", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: Invalid token"));
    await expect(sendOfferOpeningBatch({ authToken: "bad", env })).rejects.toThrow("Unauthorized");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("destinataires et aperçu", () => {
  it("compte les demandes actives non prévenues, les prévenues, et montre l'aperçu", async () => {
    database({ recipients: 42, notified: 7, needsReview: 2 });
    const audience = await getOfferOpeningAudience({ authToken: "t", env });
    expect(audience).toMatchObject({
      recipients: 42,
      needsReview: 2,
      alreadyNotified: 7,
      batchSize: 200,
      configured: true,
      missing: [],
    });
    expect(audience.preview.subject).toBe("Immojudis : l’ouverture de l’offre Analyse");
    expect(audience.preview.text).toContain("https://immojudis.test/offres");
    // L'aperçu n'expose aucun jeton signé.
    expect(audience.preview.text).not.toMatch(/token=/);
  });

  it("sans la fonction de file (migration pas appliquée), compte comme avant les demandes actives", async () => {
    database({ recipients: 9, notified: 1, rpcMissing: true });
    const audience = await getOfferOpeningAudience({ authToken: "t", env });
    expect(audience).toMatchObject({ recipients: 9, needsReview: 0, alreadyNotified: 1 });
  });

  it("n'avale pas une autre erreur de la file", async () => {
    database({ recipients: 9 });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(getOfferOpeningAudience({ authToken: "t", env })).rejects.toBeTruthy();
  });

  it("dit ce qui manque à la configuration d'envoi", async () => {
    database();
    const audience = await getOfferOpeningAudience({
      authToken: "t",
      env: { SITE_URL: "https://immojudis.test" } as unknown as Pick<NodeJS.ProcessEnv, string>,
    });
    expect(audience.configured).toBe(false);
    expect(audience.missing).toEqual(["RESEND_API_KEY", "ALERT_EMAIL_FROM"]);
  });
});

describe("envoi d'essai", () => {
  it("part vers l'adresse de l'administrateur, objet marqué, et jamais vers la liste", async () => {
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "admin@immojudis.test", email_confirmed_at: "x" } },
      error: null,
    });
    await expect(sendOfferOpeningTest({ authToken: "t", now: NOW, env })).resolves.toEqual({
      sentTo: "admin@immojudis.test",
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].message.to).toBe("admin@immojudis.test");
    expect(mocks.send.mock.calls[0][0].message.subject).toContain("[Test]");
    // Aucune écriture : un essai ne marque personne comme prévenu.
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("n'envoie rien quand l'envoi d'emails n'est pas configuré", async () => {
    await expect(
      sendOfferOpeningTest({
        authToken: "t",
        env: {} as unknown as Pick<NodeJS.ProcessEnv, string>,
      }),
    ).rejects.toThrow("n’est pas configuré");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("envoi d'un lot", () => {
  it("écrit notified_at avant l'envoi, pour chaque destinataire, avec son lien signé", async () => {
    const { updates } = database({ rows: [idOf(1), idOf(2)], recipients: 2 });
    const result = await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });

    expect(result).toEqual({ sent: 2, failed: 0, skipped: 0, remaining: 0, stoppedEarly: false });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(updates.map(({ patch }) => patch.notified_at)).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
    ]);
    const first = mocks.send.mock.calls.find(
      ([call]) => call.message.to === `${idOf(1)}@exemple.fr`,
    )?.[0];
    expect(first.idempotencyKey).toBe(`immojudis-offer-opening-${idOf(1)}`);
    expect(first.message.subject).not.toContain("[Test]");
    const token = new URL(first.message.unsubscribeUrl).searchParams.get("token");
    expect(verifyUnsubscribeToken(token, { now: NOW, env })).toMatchObject({
      userId: idOf(1),
      scope: { kind: "offer-opening" },
    });
  });

  it("sans la fonction de file (migration pas appliquée), ne cible que les demandes actives non prévenues, les plus anciennes d'abord, 200 au plus", async () => {
    const selects: Call[][] = [];
    mocks.resolve.mockImplementation((calls: Call[]) => {
      selects.push(calls);
      return { data: [], count: 0, error: null };
    });
    await sendOfferOpeningBatch({ authToken: "t", limit: 5_000, env });
    const list = selects.find((calls) => has(calls, "limit"))!;
    expect(args(list, "limit")).toEqual([200]);
    expect(list.filter(([method]) => method === "eq").map(([, a]) => a)).toEqual([
      ["offer_code", "analyse"],
      ["notify_enabled", true],
    ]);
    expect(list.find(([method]) => method === "is")?.[1]).toEqual(["notified_at", null]);
    expect(args(list, "order")).toEqual(["consented_at", { ascending: true }]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("lit la file en base : demandes à adresse confirmée seulement, 200 au plus, sans relire la table", async () => {
    const selects: Call[][] = [];
    const { rpcCalls } = database({ rows: [idOf(1)], recipients: 1 });
    const resolve = mocks.resolve.getMockImplementation()!;
    mocks.resolve.mockImplementation((calls: Call[]) => {
      selects.push(calls);
      return resolve(calls);
    });
    await sendOfferOpeningBatch({ authToken: "t", limit: 5_000, now: NOW, env });
    expect(rpcCalls[0]).toEqual({ fn: "get_offer_opening_queue", params: { p_limit: 200 } });
    // Aucune sélection de candidats dans la table : seule la file en base décide.
    expect(selects.filter((calls) => has(calls, "order"))).toEqual([]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("compte l'essai en posant la marque, et date le premier essai de la série", async () => {
    const { updates } = database({
      queue: [
        { user_id: idOf(1), attempts: 0, attempted_at: null },
        { user_id: idOf(2), attempts: 1, attempted_at: "2026-10-30T02:00:00.000Z" },
      ],
      recipients: 2,
    });
    await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    const claims = updates.filter(({ patch }) => patch.notified_at);
    expect(claims.find(({ userId }) => userId === idOf(1))?.patch).toEqual({
      notified_at: NOW.toISOString(),
      notify_attempts: 1,
      notify_attempted_at: NOW.toISOString(),
    });
    // Un second essai garde la date du premier : la clé d'idempotence de Resend court à partir de là.
    expect(claims.find(({ userId }) => userId === idOf(2))?.patch).toEqual({
      notified_at: NOW.toISOString(),
      notify_attempts: 2,
      notify_attempted_at: "2026-10-30T02:00:00.000Z",
    });
  });

  it("garde la même clé d'idempotence à chaque essai d'un compte", async () => {
    database({
      queue: [{ user_id: idOf(2), attempts: 1, attempted_at: "2026-10-30T02:00:00.000Z" }],
      recipients: 1,
    });
    await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    expect(mocks.send.mock.calls[0][0].idempotencyKey).toBe(`immojudis-offer-opening-${idOf(2)}`);
  });

  it("n'essaie qu'une fois par passage une demande que la file rend deux fois", async () => {
    const { updates } = database({
      queue: [
        { user_id: idOf(1), attempts: 0, attempted_at: null },
        { user_id: idOf(1), attempts: 0, attempted_at: null },
      ],
      recipients: 1,
    });
    await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(updates.filter(({ patch }) => patch.notified_at)).toHaveLength(1);
  });

  it("rend la marque après un échec sans effacer le compteur d'essais", async () => {
    const { updates } = database({ rows: [idOf(1)], recipients: 1 });
    mocks.send.mockRejectedValue(new Error("Resend a refusé l'envoi (500)."));
    await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    const release = updates.find(({ patch }) => patch.notified_at === null);
    // Seule la marque est rendue : le compteur et la date du premier essai restent.
    expect(release?.patch).toEqual({ notified_at: null });
  });

  it("sans la fonction de file (migration pas appliquée), pose seulement la marque", async () => {
    const { updates } = database({ rows: [idOf(1)], recipients: 1, rpcMissing: true });
    const result = await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    expect(result.sent).toBe(1);
    expect(updates[0].patch).toEqual({ notified_at: NOW.toISOString() });
  });

  it("n'avale pas une autre erreur de la file : aucun envoi", async () => {
    database({ rows: [idOf(1)], recipients: 1 });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(sendOfferOpeningBatch({ authToken: "t", now: NOW, env })).rejects.toBeTruthy();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("lot de comptes non confirmés : la file ne les rend pas, le lot est fait des comptes confirmés", async () => {
    // La base ne rend que les adresses confirmées : 200 comptes non confirmés plus anciens ne bloquent plus.
    database({ rows: [idOf(201), idOf(202)], recipients: 2 });
    const result = await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    expect(result).toMatchObject({ sent: 2, skipped: 0 });
  });

  it("idempotent : une demande déjà marquée par un autre envoi n'est pas renvoyée", async () => {
    database({ rows: [idOf(1), idOf(2)], claimed: (userId) => userId !== idOf(1), recipients: 1 });
    const result = await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].message.to).toBe(`${idOf(2)}@exemple.fr`);
  });

  it("relancé quand plus personne n'est à prévenir : aucun envoi, aucune écriture", async () => {
    const { updates } = database({ rows: [], recipients: 0 });
    const result = await sendOfferOpeningBatch({ authToken: "t", env });
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0, remaining: 0, stoppedEarly: false });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("retire la marque quand l'envoi échoue, pour pouvoir réessayer", async () => {
    const { updates } = database({ rows: [idOf(1), idOf(2)], recipients: 2 });
    mocks.send.mockImplementation(async ({ message }: { message: { to: string } }) => {
      if (message.to.startsWith(idOf(1))) throw new Error("Resend a refusé l'envoi (500).");
      return { id: "ok" };
    });
    const result = await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    expect(result).toMatchObject({ sent: 1, failed: 1, skipped: 0, remaining: 1 });
    const released = updates.filter(({ patch }) => patch.notified_at === null);
    expect(released.map(({ userId }) => userId)).toEqual([idOf(1)]);
  });

  it("n'écrit à personne dont l'adresse est absente ou non confirmée, et rend la marque", async () => {
    const { updates } = database({ rows: [idOf(1), idOf(2)], recipients: 2 });
    mocks.getUserById.mockImplementation(async (userId: string) => ({
      data: {
        user:
          userId === idOf(1)
            ? { email: "a@exemple.fr", email_confirmed_at: null }
            : { email: null, email_confirmed_at: "x" },
      },
      error: null,
    }));
    const result = await sendOfferOpeningBatch({ authToken: "t", now: NOW, env });
    expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 2 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(updates.filter(({ patch }) => patch.notified_at === null)).toHaveLength(2);
  });

  it("s'arrête proprement quand le budget de temps est atteint", async () => {
    database({ rows: [idOf(1), idOf(2), idOf(3)], recipients: 3 });
    let tick = 0;
    const clock = () => (tick++ === 0 ? 0 : 60_000);
    const result = await sendOfferOpeningBatch({ authToken: "t", now: NOW, env, clock });
    expect(result.stoppedEarly).toBe(true);
    expect(result.sent).toBeLessThan(3);
  });

  it("n'écrit rien et n'envoie rien quand l'envoi d'emails n'est pas configuré", async () => {
    database({ rows: [idOf(1)], recipients: 1 });
    await expect(
      sendOfferOpeningBatch({
        authToken: "t",
        env: {} as unknown as Pick<NodeJS.ProcessEnv, string>,
      }),
    ).rejects.toThrow("n’est pas configuré");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
