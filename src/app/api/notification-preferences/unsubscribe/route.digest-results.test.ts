import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeEmailAlertConsent: vi.fn(async ({ userId }: { userId: string }) => ({
    userId,
    revokedAt: "2026-10-09T10:00:00.000Z",
  })),
  revokeSaleReminderConsent: vi.fn(async ({ userId }: { userId: string }) => ({
    userId,
    revokedAt: "2026-10-19T10:00:00.000Z",
  })),
  revokeWeeklyDigestConsent: vi.fn(async ({ userId }: { userId: string }) => ({
    userId,
    revokedAt: "2026-10-21T10:00:00.000Z",
  })),
  revokeSaleResultsConsent: vi.fn(async ({ userId }: { userId: string }) => ({
    userId,
    revokedAt: "2026-10-21T10:00:00.000Z",
  })),
  revokeOfferOpeningRequest: vi.fn(),
  deactivateAlertForUser: vi.fn(),
  unsubscribeEmailAlertsByNotificationId: vi.fn(),
}));

vi.mock("@/lib/email-alerts", () => mocks);

import { createUnsubscribeToken, type UnsubscribeScope } from "@/lib/email-unsubscribe-token";
import { GET, POST } from "./route";

const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const URL_BASE = "https://immojudis.test/api/notification-preferences/unsubscribe";

function post(token: string) {
  return POST(
    new Request(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
    }),
  );
}

describe("désinscription du récapitulatif hebdomadaire et de l'alerte de résultat", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  it.each([
    ["weekly-digest", "récapitulatif hebdomadaire", "Me désinscrire du récapitulatif"],
    ["sale-results", "alertes de résultat", "Me désinscrire des alertes de résultat"],
  ] as const)(
    "n'écrit rien sur un GET d'un jeton « %s » et demande confirmation",
    async (kind, wording, button) => {
      const token = createUnsubscribeToken({ userId, scope: { kind } });
      const response = await GET(new Request(`${URL_BASE}?token=${token}`));
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('method="post"');
      expect(html).toContain(wording);
      expect(html).toContain(button);
      for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
    },
  );

  it("retire le seul récapitulatif sur le POST d'un jeton « weekly-digest »", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "weekly-digest" } });
    const response = await post(token);
    expect(response.status).toBe(200);
    expect(mocks.revokeWeeklyDigestConsent).toHaveBeenCalledWith({ userId });
    expect(mocks.revokeSaleResultsConsent).not.toHaveBeenCalled();
    expect(mocks.revokeSaleReminderConsent).not.toHaveBeenCalled();
    expect(mocks.revokeEmailAlertConsent).not.toHaveBeenCalled();
    expect(await response.text()).toContain(
      "Vos alertes email et vos autres emails ne sont pas modifiés",
    );
  });

  it("retire la seule alerte de résultat sur le POST d'un jeton « sale-results »", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "sale-results" } });
    const response = await post(token);
    expect(response.status).toBe(200);
    expect(mocks.revokeSaleResultsConsent).toHaveBeenCalledWith({ userId });
    expect(mocks.revokeWeeklyDigestConsent).not.toHaveBeenCalled();
    expect(mocks.revokeSaleReminderConsent).not.toHaveBeenCalled();
    expect(mocks.revokeEmailAlertConsent).not.toHaveBeenCalled();
  });

  it("désinscrit aussi sur le POST one-click envoyé par le client mail", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "weekly-digest" } });
    const response = await POST(
      new Request(`${URL_BASE}?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.revokeWeeklyDigestConsent).toHaveBeenCalledWith({ userId });
  });

  it("garde les portées étanches : un lien de rappels ne retire ni le récapitulatif ni l'alerte", async () => {
    const scope: UnsubscribeScope = { kind: "reminders" };
    await post(createUnsubscribeToken({ userId, scope }));
    expect(mocks.revokeSaleReminderConsent).toHaveBeenCalledTimes(1);
    expect(mocks.revokeWeeklyDigestConsent).not.toHaveBeenCalled();
    expect(mocks.revokeSaleResultsConsent).not.toHaveBeenCalled();
  });

  it("renvoie vers le compte quand le lien est expiré, sans rien retirer", async () => {
    const longAgo = new Date("2024-01-01T00:00:00Z");
    for (const kind of ["weekly-digest", "sale-results"] as const) {
      const token = createUnsubscribeToken({ userId, scope: { kind }, now: longAgo });
      const response = await post(token);
      const html = await response.text();
      expect(response.status, kind).toBe(400);
      expect(html).toContain('href="/compte"');
    }
    expect(mocks.revokeWeeklyDigestConsent).not.toHaveBeenCalled();
    expect(mocks.revokeSaleResultsConsent).not.toHaveBeenCalled();
  });
});
