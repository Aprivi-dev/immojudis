import { describe, expect, it } from "vitest";
import {
  buildNotificationPreferencePatch,
  buildSaleReminderPreferencePatch,
  canCreateEmailAlertNotification,
  canSendSaleReminder,
  notificationPreferenceUpdateSchema,
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

  it("date le premier consentement et garde la date d'origine ensuite", () => {
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
      sale_reminders_consented_at: "2026-10-19T10:00:00.000Z",
      sale_reminders_revoked_at: null,
    });
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
