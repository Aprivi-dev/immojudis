import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNotificationPreferences,
  notificationPreferenceUpdateSchema,
  SALE_RESULTS_CONSENT_TEXT_VERSION,
  SALE_RESULTS_NOT_OFFERED_MESSAGE,
  updateNotificationPreferences,
  WEEKLY_DIGEST_CONSENT_TEXT_VERSION,
  WEEKLY_DIGEST_NOT_OFFERED_MESSAGE,
} from "@/lib/notification-preferences";

/** Récapitulatif hebdomadaire « Ma semaine » et alerte de résultat : consentements distincts. */
describe("récapitulatif hebdomadaire et alerte de résultat : consentements distincts", () => {
  afterEach(() => vi.unstubAllEnvs());

  function fakeAuth(isAdmin: boolean, row: Record<string, unknown> | null = null) {
    const upsert = vi.fn((patch: Record<string, unknown>) => ({
      select: () => ({ single: async () => ({ data: { ...patch }, error: null }) }),
    }));
    const auth = {
      userId: "user-1",
      isAdmin,
      supabase: {
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
          upsert,
        }),
      },
    };
    return { auth: auth as never, upsert };
  }

  const NOW = new Date("2026-10-21T10:00:00.000Z");
  const weekly = { weeklyDigestEnabled: true, consentSource: "settings" as const };
  const results = { saleResultsEnabled: true, consentSource: "settings" as const };

  it("accepte ces mises à jour seules et borne le jour de 1 à 7", () => {
    expect(notificationPreferenceUpdateSchema.parse({ weeklyDigestEnabled: true })).toEqual(weekly);
    expect(notificationPreferenceUpdateSchema.parse({ saleResultsEnabled: false })).toEqual({
      saleResultsEnabled: false,
      consentSource: "settings",
    });
    expect(notificationPreferenceUpdateSchema.parse({ weeklyDigestWeekday: 5 })).toEqual({
      weeklyDigestWeekday: 5,
      consentSource: "settings",
    });
    for (const weekday of [0, 8, 2.5, "mardi"]) {
      expect(
        notificationPreferenceUpdateSchema.safeParse({ weeklyDigestWeekday: weekday }).success,
        String(weekday),
      ).toBe(false);
    }
  });

  it("lit des cases décochées et le mardi quand la personne n'a encore rien enregistré", async () => {
    const { auth } = fakeAuth(false);
    const { preferences, weeklyDigestAvailable, saleResultsAvailable } =
      await getNotificationPreferences({ auth });
    expect(preferences).toMatchObject({
      weeklyDigestEnabled: false,
      weeklyDigestConsentedAt: null,
      weeklyDigestWeekday: 2,
      saleResultsEnabled: false,
      saleResultsConsentedAt: null,
    });
    // Interrupteurs fermés par défaut : aucune case n'est proposée.
    expect(weeklyDigestAvailable).toBe(false);
    expect(saleResultsAvailable).toBe(false);
  });

  it("propose chaque case selon son propre interrupteur, jamais selon celui des rappels", async () => {
    vi.stubEnv("SALE_REMINDERS_MODE", "on");
    const closed = await getNotificationPreferences({ auth: fakeAuth(false).auth });
    expect(closed.saleRemindersAvailable).toBe(true);
    expect(closed.weeklyDigestAvailable).toBe(false);
    expect(closed.saleResultsAvailable).toBe(false);

    vi.stubEnv("WEEKLY_DIGEST_MODE", "internal");
    vi.stubEnv("SALE_RESULTS_MODE", "on");
    const user = await getNotificationPreferences({ auth: fakeAuth(false).auth });
    expect(user.weeklyDigestAvailable).toBe(false);
    expect(user.saleResultsAvailable).toBe(true);
    const admin = await getNotificationPreferences({ auth: fakeAuth(true).auth });
    expect(admin.weeklyDigestAvailable).toBe(true);
  });

  it.each([
    ["récapitulatif, sans variable (off)", "WEEKLY_DIGEST_MODE", undefined, false],
    ["récapitulatif, off", "WEEKLY_DIGEST_MODE", "off", true],
    ["récapitulatif, internal hors administrateur", "WEEKLY_DIGEST_MODE", "internal", false],
    ["alerte de résultat, sans variable (off)", "SALE_RESULTS_MODE", undefined, false],
    ["alerte de résultat, off", "SALE_RESULTS_MODE", "off", true],
    ["alerte de résultat, internal hors administrateur", "SALE_RESULTS_MODE", "internal", false],
  ])("refuse l'activation : %s", async (_label, variable, mode, isAdmin) => {
    // Les rappels ouverts n'ouvrent ni l'un ni l'autre.
    vi.stubEnv("SALE_REMINDERS_MODE", "on");
    if (mode) vi.stubEnv(variable, mode);
    const weeklyCase = variable === "WEEKLY_DIGEST_MODE";
    const { auth, upsert } = fakeAuth(isAdmin);
    await expect(
      updateNotificationPreferences({ auth, input: weeklyCase ? weekly : results, now: NOW }),
    ).rejects.toMatchObject({
      status: 409,
      message: weeklyCase ? WEEKLY_DIGEST_NOT_OFFERED_MESSAGE : SALE_RESULTS_NOT_OFFERED_MESSAGE,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("enregistre l'état et la version du texte consenti côté serveur, sans date venue du client", async () => {
    vi.stubEnv("WEEKLY_DIGEST_MODE", "on");
    vi.stubEnv("SALE_RESULTS_MODE", "on");
    const enabling = fakeAuth(false);
    await updateNotificationPreferences({
      auth: enabling.auth,
      input: { ...weekly, saleResultsEnabled: true },
      now: NOW,
    });
    const patch = enabling.upsert.mock.calls[0][0];
    expect(patch).toMatchObject({
      user_id: "user-1",
      weekly_digest_enabled: true,
      weekly_digest_consent_text_version: WEEKLY_DIGEST_CONSENT_TEXT_VERSION,
      sale_results_enabled: true,
      sale_results_consent_text_version: SALE_RESULTS_CONSENT_TEXT_VERSION,
    });
    // Les dates de consentement et de retrait sont posées par la base (déclencheur), jamais envoyées.
    for (const key of [
      "weekly_digest_consented_at",
      "weekly_digest_revoked_at",
      "sale_results_consented_at",
      "sale_results_revoked_at",
      "alert_email_enabled",
      "sale_reminders_enabled",
    ]) {
      expect(patch, key).not.toHaveProperty(key);
    }
  });

  it("permet toujours de retirer chaque consentement, même quand l'envoi est fermé, sans version", async () => {
    const { auth, upsert } = fakeAuth(false);
    await updateNotificationPreferences({
      auth,
      input: { weeklyDigestEnabled: false, saleResultsEnabled: false, consentSource: "settings" },
      now: NOW,
    });
    const patch = upsert.mock.calls[0][0];
    expect(patch).toMatchObject({ weekly_digest_enabled: false, sale_results_enabled: false });
    expect(patch).not.toHaveProperty("weekly_digest_consent_text_version");
    expect(patch).not.toHaveProperty("sale_results_consent_text_version");
  });

  it("enregistre le jour choisi sans toucher aux consentements, même quand l'envoi est fermé", async () => {
    const { auth, upsert } = fakeAuth(false);
    await updateNotificationPreferences({
      auth,
      input: { weeklyDigestWeekday: 4, consentSource: "settings" },
      now: NOW,
    });
    const patch = upsert.mock.calls[0][0];
    expect(Object.keys(patch).sort()).toEqual(["user_id", "weekly_digest_weekday"]);
    expect(patch.weekly_digest_weekday).toBe(4);
  });

  it("ne touche ni aux alertes, ni aux rappels, ni à l'autre email en cochant le récapitulatif", async () => {
    vi.stubEnv("WEEKLY_DIGEST_MODE", "on");
    const { auth, upsert } = fakeAuth(false);
    await updateNotificationPreferences({ auth, input: weekly, now: NOW });
    const keys = Object.keys(upsert.mock.calls[0][0]);
    expect(
      keys.some(
        (key) =>
          key.startsWith("alert_email") ||
          key.startsWith("sale_reminders") ||
          key.startsWith("sale_results"),
      ),
    ).toBe(false);
  });
});
