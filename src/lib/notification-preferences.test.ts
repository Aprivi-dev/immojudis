import { afterEach, describe, expect, it, vi } from "vitest";

// L'écriture se fait avec le rôle de service (`supabaseAdmin`), la lecture avec le rôle de la personne.
const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ upsert: mocks.upsert }) },
}));
import {
  buildNotificationPreferencePatch,
  buildSaleReminderPreferencePatch,
  canCreateEmailAlertNotification,
  canSendSaleReminder,
  notificationPreferenceUpdateSchema,
  SALE_REMINDERS_CONSENT_TEXT_VERSION,
  SALE_REMINDERS_NOT_OFFERED_MESSAGE,
  updateNotificationPreferences,
} from "@/lib/notification-preferences";

describe("notification preferences", () => {
  it("validates preference updates", () => {
    expect(
      notificationPreferenceUpdateSchema.parse({
        alertEmailEnabled: true,
      }),
    ).toEqual({
      alertEmailEnabled: true,
      consentSource: "settings",
    });
  });

  it("timestamps first email consent and keeps the original consent date", () => {
    const first = buildNotificationPreferencePatch({
      current: {
        alertEmailEnabled: false,
        alertEmailConsentedAt: null,
        alertEmailRevokedAt: null,
      },
      enabled: true,
      consentSource: "settings",
      timestamp: "2026-07-06T10:00:00.000Z",
    });

    expect(first).toMatchObject({
      alert_email_enabled: true,
      alert_email_consented_at: "2026-07-06T10:00:00.000Z",
      alert_email_revoked_at: null,
    });

    const second = buildNotificationPreferencePatch({
      current: {
        alertEmailEnabled: false,
        alertEmailConsentedAt: "2026-07-06T10:00:00.000Z",
        alertEmailRevokedAt: "2026-07-06T12:00:00.000Z",
      },
      enabled: true,
      consentSource: "settings",
      timestamp: "2026-07-07T10:00:00.000Z",
    });

    expect(second.alert_email_consented_at).toBe("2026-07-06T10:00:00.000Z");
    expect(second.alert_email_revoked_at).toBeNull();
  });

  it("timestamps revocation only when email was enabled", () => {
    expect(
      buildNotificationPreferencePatch({
        current: {
          alertEmailEnabled: true,
          alertEmailConsentedAt: "2026-07-06T10:00:00.000Z",
          alertEmailRevokedAt: null,
        },
        enabled: false,
        consentSource: "settings",
        timestamp: "2026-07-06T12:00:00.000Z",
      }),
    ).toMatchObject({
      alert_email_enabled: false,
      alert_email_consented_at: "2026-07-06T10:00:00.000Z",
      alert_email_revoked_at: "2026-07-06T12:00:00.000Z",
    });
  });

  it("allows email notification creation only with enabled consent timestamp", () => {
    expect(
      canCreateEmailAlertNotification({
        alertEmailEnabled: true,
        alertEmailConsentedAt: "2026-07-06T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      canCreateEmailAlertNotification({
        alertEmailEnabled: true,
        alertEmailConsentedAt: null,
      }),
    ).toBe(false);
  });

  it("accepte une mise à jour des seuls rappels d'audience, et refuse une mise à jour vide", () => {
    expect(notificationPreferenceUpdateSchema.parse({ saleRemindersEnabled: true })).toEqual({
      saleRemindersEnabled: true,
      consentSource: "settings",
    });
    expect(notificationPreferenceUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      notificationPreferenceUpdateSchema.safeParse({ consentSource: "settings" }).success,
    ).toBe(false);
  });
});

describe("rappels d'audience : consentement distinct", () => {
  const never = {
    saleRemindersEnabled: false,
    saleRemindersConsentedAt: null,
    saleRemindersRevokedAt: null,
  };

  it("date le premier consentement, puis redate chaque nouveau consentement après un retrait", () => {
    expect(
      buildSaleReminderPreferencePatch({
        current: never,
        enabled: true,
        timestamp: "2026-10-19T10:00:00.000Z",
      }),
    ).toEqual({
      sale_reminders_enabled: true,
      sale_reminders_consented_at: "2026-10-19T10:00:00.000Z",
      sale_reminders_revoked_at: null,
    });

    expect(
      buildSaleReminderPreferencePatch({
        current: {
          saleRemindersEnabled: false,
          saleRemindersConsentedAt: "2026-10-19T10:00:00.000Z",
          saleRemindersRevokedAt: "2026-10-20T10:00:00.000Z",
        },
        enabled: true,
        timestamp: "2026-10-21T10:00:00.000Z",
      }),
    ).toMatchObject({
      sale_reminders_consented_at: "2026-10-21T10:00:00.000Z",
      sale_reminders_revoked_at: null,
    });
  });

  it("garde la date d'origine quand les rappels sont déjà actifs", () => {
    expect(
      buildSaleReminderPreferencePatch({
        current: {
          saleRemindersEnabled: true,
          saleRemindersConsentedAt: "2026-10-19T10:00:00.000Z",
          saleRemindersRevokedAt: null,
        },
        enabled: true,
        timestamp: "2026-10-21T10:00:00.000Z",
      }).sale_reminders_consented_at,
    ).toBe("2026-10-19T10:00:00.000Z");
  });

  it("date le retrait seulement quand les rappels étaient actifs", () => {
    expect(
      buildSaleReminderPreferencePatch({
        current: {
          saleRemindersEnabled: true,
          saleRemindersConsentedAt: "2026-10-19T10:00:00.000Z",
          saleRemindersRevokedAt: null,
        },
        enabled: false,
        timestamp: "2026-10-20T10:00:00.000Z",
      }),
    ).toEqual({
      sale_reminders_enabled: false,
      sale_reminders_consented_at: "2026-10-19T10:00:00.000Z",
      sale_reminders_revoked_at: "2026-10-20T10:00:00.000Z",
    });
    expect(
      buildSaleReminderPreferencePatch({
        current: never,
        enabled: false,
        timestamp: "2026-10-20T10:00:00.000Z",
      }).sale_reminders_revoked_at,
    ).toBeNull();
  });

  it("n'envoie qu'avec un consentement actif et daté", () => {
    expect(
      canSendSaleReminder({
        saleRemindersEnabled: true,
        saleRemindersConsentedAt: "2026-10-19T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      canSendSaleReminder({ saleRemindersEnabled: true, saleRemindersConsentedAt: null }),
    ).toBe(false);
    expect(
      canSendSaleReminder({
        saleRemindersEnabled: false,
        saleRemindersConsentedAt: "2026-10-19T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("ne mélange pas les deux consentements dans le patch", () => {
    const alerts = buildNotificationPreferencePatch({
      current: { alertEmailEnabled: false, alertEmailConsentedAt: null, alertEmailRevokedAt: null },
      enabled: true,
      consentSource: "settings",
      timestamp: "2026-10-19T10:00:00.000Z",
    });
    expect(Object.keys(alerts).some((key) => key.startsWith("sale_reminders"))).toBe(false);
    const reminders = buildSaleReminderPreferencePatch({
      current: never,
      enabled: true,
      timestamp: "2026-10-19T10:00:00.000Z",
    });
    expect(Object.keys(reminders).some((key) => key.startsWith("alert_email"))).toBe(false);
  });
});

describe("rappels d'audience : activation seulement quand l'envoi est proposé", () => {
  afterEach(() => vi.unstubAllEnvs());

  function fakeAuth(isAdmin: boolean, row: Record<string, unknown> | null = null) {
    const upsert = mocks.upsert;
    upsert.mockReset();
    upsert.mockImplementation((patch: Record<string, unknown>) => ({
      select: () => ({ single: async () => ({ data: { ...patch }, error: null }) }),
    }));
    // Une écriture avec le rôle de la personne serait refusée par la base : elle ne doit pas avoir lieu.
    const userUpsert = vi.fn();
    const auth = {
      userId: "user-1",
      isAdmin,
      supabase: {
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
          upsert: userUpsert,
        }),
      },
    };
    return { auth: auth as never, upsert, userUpsert };
  }

  const activate = { saleRemindersEnabled: true, consentSource: "settings" as const };
  const NOW = new Date("2026-10-21T10:00:00.000Z");

  it.each([
    ["sans variable (off)", undefined, false],
    ["off", "off", true],
    ["internal pour un compte qui n'est pas administrateur", "internal", false],
  ])("refuse l'activation : %s", async (_label, mode, isAdmin) => {
    if (mode) vi.stubEnv("SALE_REMINDERS_MODE", mode);
    const { auth, upsert } = fakeAuth(isAdmin);
    await expect(
      updateNotificationPreferences({ auth, input: activate, now: NOW }),
    ).rejects.toMatchObject({
      status: 409,
      message: SALE_REMINDERS_NOT_OFFERED_MESSAGE,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("accepte l'activation en mode internal pour un administrateur et en mode on", async () => {
    vi.stubEnv("SALE_REMINDERS_MODE", "internal");
    const admin = fakeAuth(true);
    await updateNotificationPreferences({ auth: admin.auth, input: activate, now: NOW });
    expect(admin.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sale_reminders_enabled: true,
        sale_reminders_consented_at: NOW.toISOString(),
      }),
      { onConflict: "user_id" },
    );

    vi.stubEnv("SALE_REMINDERS_MODE", "on");
    const user = fakeAuth(false);
    await updateNotificationPreferences({ auth: user.auth, input: activate, now: NOW });
    expect(user.upsert).toHaveBeenCalledTimes(1);
  });

  it("écrit avec le rôle de service, jamais avec celui de la personne (consentements, version du texte)", async () => {
    vi.stubEnv("SALE_REMINDERS_MODE", "on");
    const { auth, upsert, userUpsert } = fakeAuth(false);
    await updateNotificationPreferences({ auth, input: activate, now: NOW });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ user_id: "user-1" });
    expect(userUpsert).not.toHaveBeenCalled();

    // Même les alertes par email passent par la route, avec l'identifiant du jeton.
    const alerts = fakeAuth(false);
    await updateNotificationPreferences({
      auth: alerts.auth,
      input: { alertEmailEnabled: true, consentSource: "settings" },
      now: NOW,
    });
    expect(alerts.upsert.mock.calls[0][0]).toMatchObject({ user_id: "user-1" });
    expect(alerts.userUpsert).not.toHaveBeenCalled();
  });

  it("renseigne côté serveur la version du texte consenti, seulement à l'activation", async () => {
    vi.stubEnv("SALE_REMINDERS_MODE", "on");
    const enabling = fakeAuth(false);
    await updateNotificationPreferences({ auth: enabling.auth, input: activate, now: NOW });
    expect(enabling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sale_reminders_consent_text_version: SALE_REMINDERS_CONSENT_TEXT_VERSION,
      }),
      { onConflict: "user_id" },
    );

    const revoking = fakeAuth(false, {
      sale_reminders_enabled: true,
      sale_reminders_consented_at: "2026-10-19T10:00:00.000Z",
      sale_reminders_revoked_at: null,
    });
    await updateNotificationPreferences({
      auth: revoking.auth,
      input: { saleRemindersEnabled: false, consentSource: "settings" },
      now: NOW,
    });
    expect(revoking.upsert.mock.calls[0][0]).not.toHaveProperty(
      "sale_reminders_consent_text_version",
    );

    // Une mise à jour des seules alertes ne touche pas à la version du texte des rappels.
    const alertsOnly = fakeAuth(false);
    await updateNotificationPreferences({
      auth: alertsOnly.auth,
      input: { alertEmailEnabled: true, consentSource: "settings" },
      now: NOW,
    });
    expect(alertsOnly.upsert.mock.calls[0][0]).not.toHaveProperty(
      "sale_reminders_consent_text_version",
    );
  });

  it("permet toujours de retirer le consentement, même quand l'envoi est fermé", async () => {
    const { auth, upsert } = fakeAuth(false, {
      sale_reminders_enabled: true,
      sale_reminders_consented_at: "2026-10-19T10:00:00.000Z",
      sale_reminders_revoked_at: null,
    });
    await updateNotificationPreferences({
      auth,
      input: { saleRemindersEnabled: false, consentSource: "settings" },
      now: NOW,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sale_reminders_enabled: false,
        sale_reminders_revoked_at: NOW.toISOString(),
      }),
      { onConflict: "user_id" },
    );
  });

  it("redate le consentement quand la personne reconsent après un retrait", async () => {
    vi.stubEnv("SALE_REMINDERS_MODE", "on");
    const { auth, upsert } = fakeAuth(false, {
      sale_reminders_enabled: false,
      sale_reminders_consented_at: "2026-10-19T10:00:00.000Z",
      sale_reminders_revoked_at: "2026-10-20T10:00:00.000Z",
    });
    await updateNotificationPreferences({ auth, input: activate, now: NOW });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sale_reminders_consented_at: NOW.toISOString(),
        sale_reminders_revoked_at: null,
      }),
      { onConflict: "user_id" },
    );
  });
});
