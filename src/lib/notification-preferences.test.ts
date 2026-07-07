import { describe, expect, it } from "vitest";
import {
  buildNotificationPreferencePatch,
  canCreateEmailAlertNotification,
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
});
