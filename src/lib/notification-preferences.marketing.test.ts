import { afterEach, describe, expect, it, vi } from "vitest";

// L'écriture se fait avec le rôle de service (`supabaseAdmin`), la lecture avec le rôle de la personne.
const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ upsert: mocks.upsert }) },
}));
import {
  getNotificationPreferences,
  MARKETING_EMAILS_NOT_OFFERED_MESSAGE,
  notificationPreferenceUpdateSchema,
  updateNotificationPreferences,
} from "@/lib/notification-preferences";
import { MARKETING_EMAILS_CONSENT_TEXT_VERSION } from "@/lib/marketing-emails-consent";

/** Emails de nouveautés et d'offres : consentement distinct, recueilli seulement quand il est proposé. */
describe("nouveautés et offres par email : consentement distinct", () => {
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

  const NOW = new Date("2026-11-26T10:00:00.000Z");
  const marketing = { marketingEmailsEnabled: true, consentSource: "settings" as const };

  it("accepte cette mise à jour seule", () => {
    expect(notificationPreferenceUpdateSchema.parse({ marketingEmailsEnabled: true })).toEqual(
      marketing,
    );
    expect(
      notificationPreferenceUpdateSchema.safeParse({ marketingEmailsEnabled: "oui" }).success,
    ).toBe(false);
  });

  it("lit une case décochée et non proposée quand rien n'est enregistré ni ouvert", async () => {
    const { preferences, marketingEmailsAvailable } = await getNotificationPreferences({
      auth: fakeAuth(true).auth,
    });
    expect(preferences).toMatchObject({
      marketingEmailsEnabled: false,
      marketingEmailsConsentedAt: null,
      marketingEmailsRevokedAt: null,
    });
    expect(marketingEmailsAvailable).toBe(false);
  });

  it("ne propose la case que selon son propre interrupteur", async () => {
    vi.stubEnv("WEEKLY_DIGEST_MODE", "on");
    vi.stubEnv("SALE_RESULTS_MODE", "on");
    vi.stubEnv("SALE_REMINDERS_MODE", "on");
    expect(
      (await getNotificationPreferences({ auth: fakeAuth(true).auth })).marketingEmailsAvailable,
    ).toBe(false);

    vi.stubEnv("MARKETING_EMAILS_MODE", "internal");
    expect(
      (await getNotificationPreferences({ auth: fakeAuth(false).auth })).marketingEmailsAvailable,
    ).toBe(false);
    expect(
      (await getNotificationPreferences({ auth: fakeAuth(true).auth })).marketingEmailsAvailable,
    ).toBe(true);

    vi.stubEnv("MARKETING_EMAILS_MODE", "on");
    expect(
      (await getNotificationPreferences({ auth: fakeAuth(false).auth })).marketingEmailsAvailable,
    ).toBe(true);
  });

  it.each([
    ["sans variable (off)", undefined, true],
    ["off", "off", true],
    ["internal hors administrateur", "internal", false],
  ])("refuse l'activation : %s", async (_label, mode, isAdmin) => {
    // Les autres emails ouverts n'ouvrent pas celui-ci.
    vi.stubEnv("WEEKLY_DIGEST_MODE", "on");
    vi.stubEnv("SALE_RESULTS_MODE", "on");
    if (mode) vi.stubEnv("MARKETING_EMAILS_MODE", mode);
    const { auth, upsert } = fakeAuth(isAdmin);
    await expect(
      updateNotificationPreferences({ auth, input: marketing, now: NOW }),
    ).rejects.toMatchObject({ status: 409, message: MARKETING_EMAILS_NOT_OFFERED_MESSAGE });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("enregistre l'état et la version du texte côté serveur, avec le rôle de service, sans date", async () => {
    vi.stubEnv("MARKETING_EMAILS_MODE", "on");
    const { auth, upsert, userUpsert } = fakeAuth(false);
    const response = await updateNotificationPreferences({ auth, input: marketing, now: NOW });
    const patch = upsert.mock.calls[0][0];
    expect(patch).toEqual({
      user_id: "user-1",
      marketing_emails_enabled: true,
      marketing_emails_consent_text_version: MARKETING_EMAILS_CONSENT_TEXT_VERSION,
    });
    expect(userUpsert).not.toHaveBeenCalled();
    expect(response.marketingEmailsAvailable).toBe(true);
    expect(response.preferences.marketingEmailsEnabled).toBe(true);
  });

  it("permet toujours le retrait, même interrupteur éteint, sans version", async () => {
    const { auth, upsert } = fakeAuth(false);
    await updateNotificationPreferences({
      auth,
      input: { marketingEmailsEnabled: false, consentSource: "settings" },
      now: NOW,
    });
    expect(upsert.mock.calls[0][0]).toEqual({
      user_id: "user-1",
      marketing_emails_enabled: false,
    });
  });

  it("ne touche à aucun autre consentement en cochant cette case", async () => {
    vi.stubEnv("MARKETING_EMAILS_MODE", "on");
    const { auth, upsert } = fakeAuth(false);
    await updateNotificationPreferences({ auth, input: marketing, now: NOW });
    expect(
      Object.keys(upsert.mock.calls[0][0]).filter(
        (key) => key !== "user_id" && !key.startsWith("marketing_emails"),
      ),
    ).toEqual([]);
  });
});
