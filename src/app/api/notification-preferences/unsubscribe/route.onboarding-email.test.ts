import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeEmailAlertConsent: vi.fn(),
  revokeSaleReminderConsent: vi.fn(),
  revokeWeeklyDigestConsent: vi.fn(),
  revokeSaleResultsConsent: vi.fn(),
  revokeMarketingEmailsConsent: vi.fn(),
  revokeOfferOpeningRequest: vi.fn(),
  revokeLaunchOfferEndNotice: vi.fn(),
  revokeOnboardingEmail: vi.fn(async (_input: { userId: string }) => undefined),
  deactivateAlertForUser: vi.fn(),
  unsubscribeEmailAlertsByNotificationId: vi.fn(),
}));

vi.mock("@/lib/email-alerts", () => mocks);

import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { GET, POST } from "./route";

const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const URL_BASE = "https://immojudis.test/api/notification-preferences/unsubscribe";

function oneClick(token: string) {
  return POST(
    new Request(`${URL_BASE}?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }),
  );
}

describe("opposition à l'email de prise en main", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  it("n'écrit rien sur un GET et demande confirmation", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "onboarding-email" } });
    const response = await GET(new Request(`${URL_BASE}?token=${token}`));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('method="post"');
    expect(html).toContain("prise en main");
    expect(html).toContain("Ne plus recevoir ce message");
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("inscrit le compte sur la seule liste de ce message, interrupteur éteint, sans toucher aux autres", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_MODE", "off");
    const response = await oneClick(
      createUnsubscribeToken({ userId, scope: { kind: "onboarding-email" } }),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.revokeOnboardingEmail).toHaveBeenCalledWith({ userId });
    for (const [name, mock] of Object.entries(mocks)) {
      if (name !== "revokeOnboardingEmail") expect(mock, name).not.toHaveBeenCalled();
    }
    expect(html).toContain("Message désactivé");
  });

  it("garde les portées étanches : le lien de fin d'essai ne vaut pas opposition à ce message", async () => {
    await oneClick(createUnsubscribeToken({ userId, scope: { kind: "launch-offer-end" } }));
    expect(mocks.revokeLaunchOfferEndNotice).toHaveBeenCalledWith({ userId });
    expect(mocks.revokeOnboardingEmail).not.toHaveBeenCalled();
  });

  it("renvoie vers le compte quand le lien est expiré, sans rien retirer", async () => {
    const token = createUnsubscribeToken({
      userId,
      scope: { kind: "onboarding-email" },
      now: new Date("2024-01-01T00:00:00Z"),
    });
    const response = await oneClick(token);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('href="/compte"');
    expect(mocks.revokeOnboardingEmail).not.toHaveBeenCalled();
  });
});
