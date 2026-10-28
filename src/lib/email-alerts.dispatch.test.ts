import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  prefs: null as Row | null,
  activeAlerts: [] as Row[],
  updates: [] as Array<{ table: string; patch: Row; filters: Record<string, unknown> }>,
  plan: { hasAnalysisAccess: true },
  user: { email: "client@example.test", email_confirmed_at: "2026-09-01T09:00:00Z" } as Row,
  /** Liste publique des pépites lue au moment de l'envoi (`list_public_pepite_sale_ids`). */
  pepiteIds: [] as string[],
  pepiteError: null as unknown,
  rpcCalls: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const client = {
    async rpc(fn: string) {
      db.rpcCalls.push(fn);
      return db.pepiteError
        ? { data: null, error: db.pepiteError }
        : { data: db.pepiteIds, error: null };
    },
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: db.user }, error: null }),
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: Row | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return chain;
        },
        update(value: Row) {
          patch = value;
          return chain;
        },
        maybeSingle: async () => ({
          data: table === "user_notification_preferences" ? db.prefs : null,
          error: null,
        }),
        then(resolve: (value: { data: unknown; error: null }) => void) {
          if (patch) db.updates.push({ table, patch, filters: { ...filters } });
          return resolve({ data: table === "user_alerts" ? db.activeAlerts : [], error: null });
        },
      };
      return chain;
    },
  };
  return { supabaseAdmin: client };
});
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: async () => db.plan }));
vi.mock("@/lib/system-auth", () => ({
  systemAuthForUser: async (userId: string) => ({ userId, supabase: {}, claims: {} }),
}));

import { dispatchQueuedEmailAlertNotifications, readUserEmail } from "./email-alerts";

const env = {
  RESEND_API_KEY: "re_test",
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.fr>",
  NEXT_PUBLIC_APP_URL: "https://immojudis.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
};
const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const alertId = "11111111-2222-4333-8444-555555555555";

function notification(index: number) {
  return {
    id: `6b6b42a1-b719-48cc-9c9f-f0c9f707e1${index}0`,
    user_id: userId,
    alert_id: alertId,
    sale_id: `sale-${index}`,
    notification_snapshot: {
      alert: { id: alertId, name: "Bordeaux" },
      sale: { id: `sale-${index}`, title: `Vente ${index}`, city: "Bordeaux" },
      match: { reasons: ["Budget respecté"] },
    },
  } as never;
}

describe("dispatch des emails d'alerte", () => {
  beforeEach(() => {
    db.prefs = {
      alert_email_enabled: true,
      alert_email_consented_at: "2026-09-01T10:00:00Z",
    };
    db.activeAlerts = [{ id: alertId }];
    db.updates = [];
    db.plan = { hasAnalysisAccess: true };
    db.user = { email: "client@example.test", email_confirmed_at: "2026-09-01T09:00:00Z" };
    db.pepiteIds = [];
    db.pepiteError = null;
    db.rpcCalls = [];
  });

  it("n'écrit pas à une adresse non confirmée : rien n'est envoyé, les envois sont marqués en échec", async () => {
    db.user = { email: "client@example.test", email_confirmed_at: null };
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));

    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [notification(1)],
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.sentCount).toBe(0);
    expect(summary.failedCount).toBe(1);
    expect(db.updates.filter((update) => update.patch.delivery_status === "failed")).toHaveLength(
      1,
    );
  });

  it("envoie un seul email pour N ventes trouvées pour un même utilisateur", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));

    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [notification(1), notification(2), notification(3)],
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(summary.sentCount).toBe(3);
    expect(db.updates.filter((update) => update.patch.delivery_status === "sent")).toHaveLength(3);
  });

  it("annule les emails d'un utilisateur désinscrit entre-temps, sans rien envoyer", async () => {
    db.prefs = { alert_email_enabled: false, alert_email_consented_at: "2026-09-01T10:00:00Z" };
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));

    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [notification(1), notification(2)],
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.sentCount).toBe(0);
    expect(summary.skippedCount).toBe(2);
    expect(db.updates).toContainEqual(
      expect.objectContaining({
        patch: expect.objectContaining({ delivery_status: "cancelled" }),
        filters: expect.objectContaining({ user_id: userId, delivery_status: "queued" }),
      }),
    );
  });

  it("annule les emails quand l'abonnement Analyse a pris fin", async () => {
    db.plan = { hasAnalysisAccess: false };
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));

    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [notification(1)],
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.skippedCount).toBe(1);
  });

  it("envoie au compte Découverte son récapitulatif public, jamais une analyse en attente", async () => {
    db.plan = { hasAnalysisAccess: false };
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));
    const discovery = notification(1) as unknown as { notification_snapshot: Row };
    discovery.notification_snapshot = { ...discovery.notification_snapshot, audience: "discovery" };

    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [discovery as never, notification(2)],
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(summary.sentCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
  });

  it("sans configuration d'envoi, ne part rien et nomme les variables manquantes", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));
    const {
      RESEND_API_KEY: _key,
      ALERT_EMAIL_FROM: _from,
      ...withoutResend
    } = env as Record<string, string>;

    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [notification(1), notification(2)],
      env: withoutResend,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ configured: false, candidateCount: 2, skippedCount: 2 });
    expect(summary.missing).toEqual(expect.arrayContaining(["RESEND_API_KEY", "ALERT_EMAIL_FROM"]));
  });

  it("une fois configuré, ne signale aucune variable manquante", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));
    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [notification(1)],
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(summary).toMatchObject({ configured: true, missing: [] });
  });

  it("ne notifie pas pour une alerte supprimée ou en pause", async () => {
    db.activeAlerts = [];
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));

    const summary = await dispatchQueuedEmailAlertNotifications({
      notifications: [notification(1)],
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.skippedCount).toBe(1);
  });
});

describe("readUserEmail", () => {
  it("ne rend que l'adresse d'un compte qui l'a confirmée", async () => {
    db.user = { email: " client@example.test ", email_confirmed_at: "2026-09-01T09:00:00Z" };
    await expect(readUserEmail(userId)).resolves.toBe("client@example.test");
    db.user = { email: "client@example.test", email_confirmed_at: null };
    await expect(readUserEmail(userId)).resolves.toBeNull();
    db.user = { email: null, email_confirmed_at: "2026-09-01T09:00:00Z" };
    await expect(readUserEmail(userId)).resolves.toBeNull();
  });
});

describe("mention « pépite » au moment de l'envoi", () => {
  const pepiteNotification = (index: number) => {
    const base = notification(index) as unknown as { notification_snapshot: Row };
    base.notification_snapshot = {
      ...base.notification_snapshot,
      match: { reasons: ["pépite", "Budget respecté"] },
    };
    return base as never;
  };
  const sentBody = (fetchMock: ReturnType<typeof vi.fn>) =>
    JSON.parse(String((fetchMock.mock.calls[0] as unknown[][])[1]?.["body" as never] ?? "{}")) as {
      text: string;
      html: string;
    };

  beforeEach(() => {
    db.prefs = {
      alert_email_enabled: true,
      alert_email_consented_at: "2026-09-01T10:00:00Z",
    };
    db.activeAlerts = [{ id: alertId }];
    db.updates = [];
    db.plan = { hasAnalysisAccess: true };
    db.user = { email: "client@example.test", email_confirmed_at: "2026-09-01T09:00:00Z" };
    db.pepiteIds = [];
    db.pepiteError = null;
    db.rpcCalls = [];
  });

  async function send(notifications: unknown[]) {
    const fetchMock = vi.fn(async () => Response.json({ id: "email_1" }));
    await dispatchQueuedEmailAlertNotifications({
      notifications: notifications as never,
      env,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    return sentBody(fetchMock as never);
  }

  it("garde la mention quand la vente est toujours dans la liste publique des pépites", async () => {
    db.pepiteIds = ["sale-1"];
    const body = await send([pepiteNotification(1)]);
    expect(body.text).toContain("Pépite : repère calculé automatiquement");
    expect(db.rpcCalls).toEqual(["list_public_pepite_sale_ids"]);
  });

  it("retire la mention quand la vente n'est plus une pépite (arrêt d'urgence, mode shadow)", async () => {
    db.pepiteIds = [];
    const body = await send([pepiteNotification(1)]);
    expect(body.text).not.toMatch(/pépite/i);
    expect(body.html).not.toMatch(/pépite/i);
    // Les autres critères restent.
    expect(body.text).toContain("Budget respecté");
  });

  it("retire la mention quand la liste est illisible : on n'affirme rien qu'on n'a pas vérifié", async () => {
    db.pepiteError = { code: "57014" };
    const body = await send([pepiteNotification(1)]);
    expect(body.text).not.toMatch(/pépite/i);
  });

  const journalOf = () =>
    db.updates
      .filter((update) => update.table === "user_alert_notifications")
      .map(
        (update) =>
          (update.patch.notification_snapshot as { emailDelivery: Row }).emailDelivery
            .pepiteMentioned,
      );

  it("journalise la mention réellement envoyée, pas celle du résumé d'origine", async () => {
    db.pepiteIds = ["sale-1"];
    await send([pepiteNotification(1), pepiteNotification(2), notification(3)]);
    expect(journalOf()).toEqual([true, false, false]);
  });

  it("journalise « sans mention » quand la vente a quitté la liste publique", async () => {
    db.pepiteIds = [];
    await send([pepiteNotification(1)]);
    expect(journalOf()).toEqual([false]);
  });

  it("ne lit pas la liste pour une notification sans mention", async () => {
    await send([notification(1)]);
    expect(db.rpcCalls).toEqual([]);
  });
});
