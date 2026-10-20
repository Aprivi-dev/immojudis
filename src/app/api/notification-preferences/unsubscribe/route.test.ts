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
  revokeOfferOpeningRequest: vi.fn(async ({ userId }: { userId: string }) => ({
    userId,
    revokedAt: "2026-10-20T10:00:00.000Z",
  })),
  deactivateAlertForUser: vi.fn(async (_input: { userId: string; alertId: string }) => undefined),
  unsubscribeEmailAlertsByNotificationId: vi.fn(async (_input: { notificationId: string }) => ({
    userId: "u",
    revokedAt: "x",
  })),
}));
const {
  revokeEmailAlertConsent,
  revokeSaleReminderConsent,
  revokeOfferOpeningRequest,
  deactivateAlertForUser,
  unsubscribeEmailAlertsByNotificationId,
} = mocks;

vi.mock("@/lib/email-alerts", () => mocks);

import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { GET, POST } from "./route";

const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const alertId = "11111111-2222-4333-8444-555555555555";

describe("unsubscribe route", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    revokeEmailAlertConsent.mockClear();
    revokeSaleReminderConsent.mockClear();
    revokeOfferOpeningRequest.mockClear();
    deactivateAlertForUser.mockClear();
    unsubscribeEmailAlertsByNotificationId.mockClear();
  });

  it("n'écrit rien sur un GET, même avec un jeton valide (scanner de liens)", async () => {
    const token = createUnsubscribeToken({ userId });
    const response = await GET(
      new Request(`https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('method="post"');
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
    expect(deactivateAlertForUser).not.toHaveBeenCalled();
    expect(unsubscribeEmailAlertsByNotificationId).not.toHaveBeenCalled();
  });

  it("n'écrit rien sur un GET avec l'ancien lien notificationId", async () => {
    const response = await GET(
      new Request(
        "https://immojudis.test/api/notification-preferences/unsubscribe?notificationId=6b6b42a1-b719-48cc-9c9f-f0c9f707e17d",
      ),
    );
    expect(response.status).toBe(200);
    expect(unsubscribeEmailAlertsByNotificationId).not.toHaveBeenCalled();
  });

  it("désinscrit sur le POST one-click envoyé par le client mail", async () => {
    const token = createUnsubscribeToken({ userId });
    const response = await POST(
      new Request(
        `https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(revokeEmailAlertConsent).toHaveBeenCalledWith({ userId });
  });

  it("désactive une seule alerte pour un jeton par alerte", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "alert", alertId } });
    const response = await POST(
      new Request("https://immojudis.test/api/notification-preferences/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }),
    );
    expect(response.status).toBe(200);
    expect(deactivateAlertForUser).toHaveBeenCalledWith({ userId, alertId });
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
  });

  it("refuse un jeton invalide ou falsifié", async () => {
    const response = await POST(
      new Request("https://immojudis.test/api/notification-preferences/unsubscribe?token=abc.def", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
  });

  it("n'écrit rien sur un GET d'un jeton « rappels » et demande confirmation", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "reminders" } });
    const response = await GET(
      new Request(`https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("rappels d&#39;audience");
    expect(html).toContain("Me désinscrire des rappels");
    expect(revokeSaleReminderConsent).not.toHaveBeenCalled();
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
  });

  describe("lien expiré", () => {
    const longAgo = new Date("2024-01-01T00:00:00Z");
    const url = (token: string) =>
      `https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`;

    it("renvoie un jeton « rappels » expiré vers /compte, sur GET comme sur POST", async () => {
      const token = createUnsubscribeToken({ userId, scope: { kind: "reminders" }, now: longAgo });
      for (const response of [
        await GET(new Request(url(token))),
        await POST(new Request(url(token), { method: "POST" })),
      ]) {
        const html = await response.text();
        expect(response.status).toBe(400);
        expect(html).toContain('href="/compte"');
        expect(html).not.toContain('href="/alertes"');
        expect(html).toContain("rappels d&#39;audience");
      }
      expect(revokeSaleReminderConsent).not.toHaveBeenCalled();
    });

    it("renvoie un jeton d'alertes expiré vers /alertes", async () => {
      const token = createUnsubscribeToken({ userId, now: longAgo });
      const response = await GET(new Request(url(token)));
      const html = await response.text();
      expect(response.status).toBe(400);
      expect(html).toContain('href="/alertes"');
      expect(html).not.toContain('href="/compte"');
    });

    it("renvoie vers /alertes un jeton falsifié, dont la portée n'est pas fiable", async () => {
      const token = createUnsubscribeToken({ userId, scope: { kind: "reminders" } });
      const response = await GET(new Request(url(`${token}x`)));
      const html = await response.text();
      expect(response.status).toBe(400);
      expect(html).toContain('href="/alertes"');
    });

    it("accepte encore, après quatre mois, un jeton « rappels »", async () => {
      const token = createUnsubscribeToken({
        userId,
        scope: { kind: "reminders" },
        now: new Date(Date.now() - 120 * 86_400_000),
      });
      const response = await POST(new Request(url(token), { method: "POST" }));
      expect(response.status).toBe(200);
      expect(revokeSaleReminderConsent).toHaveBeenCalledWith({ userId });
    });
  });

  it("retire seulement le consentement aux rappels sur le POST one-click d'un jeton « rappels »", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "reminders" } });
    const response = await POST(
      new Request(
        `https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(revokeSaleReminderConsent).toHaveBeenCalledWith({ userId });
    // Le consentement aux alertes email reste intact.
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
    expect(html).toContain("Rappels désactivés");
    expect(html).toContain("Vos alertes email ne sont pas modifiées");
  });

  it("n'écrit rien sur un GET d'un jeton « ouverture de l'offre » et demande confirmation", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "offer-opening" } });
    const response = await GET(
      new Request(`https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("ouverture de l&#39;offre Analyse");
    expect(html).toContain("Retirer ma demande");
    expect(revokeOfferOpeningRequest).not.toHaveBeenCalled();
  });

  it("retire seulement la demande d'ouverture sur le POST d'un jeton « ouverture de l'offre »", async () => {
    const token = createUnsubscribeToken({ userId, scope: { kind: "offer-opening" } });
    const response = await POST(
      new Request(
        `https://immojudis.test/api/notification-preferences/unsubscribe?token=${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(revokeOfferOpeningRequest).toHaveBeenCalledWith({ userId });
    expect(revokeEmailAlertConsent).not.toHaveBeenCalled();
    expect(revokeSaleReminderConsent).not.toHaveBeenCalled();
    expect(html).toContain("Demande retirée");
  });
});
