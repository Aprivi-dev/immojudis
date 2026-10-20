import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  prefs: null as Row | null,
  activeAlerts: [] as Row[],
  updates: [] as Array<{ table: string; patch: Row; filters: Record<string, unknown> }>,
  plan: { hasAnalysisAccess: true },
  user: { email: "client@example.test", email_confirmed_at: "2026-09-01T09:00:00Z" } as Row,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const client = {
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
