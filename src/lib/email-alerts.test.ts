import { describe, expect, it, vi } from "vitest";
import {
  buildAlertEmailMessage,
  resolveEmailAlertDeliveryConfig,
  sendResendEmail,
} from "@/lib/email-alerts";

describe("email alerts", () => {
  it("requires Resend, sender and canonical app URL before dispatching", () => {
    expect(resolveEmailAlertDeliveryConfig({})).toMatchObject({
      configured: false,
      missing: ["RESEND_API_KEY", "ALERT_EMAIL_FROM", "NEXT_PUBLIC_APP_URL"],
    });

    expect(
      resolveEmailAlertDeliveryConfig({
        RESEND_API_KEY: "re_test",
        ALERT_EMAIL_FROM: "ImmoJudis <alertes@immojudis.fr>",
        NEXT_PUBLIC_APP_URL: "https://immojudis.example/",
      }),
    ).toMatchObject({
      configured: true,
      appUrl: "https://immojudis.example",
    });
  });

  it("builds a compliant alert email with unsubscribe and estimation limits", () => {
    const message = buildAlertEmailMessage({
      from: "ImmoJudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      notification: {
        id: "6b6b42a1-b719-48cc-9c9f-f0c9f707e17d",
        notification_snapshot: {
          alert: { name: "Bordeaux décoté" },
          sale: {
            id: "sale-1",
            title: "Maison judiciaire",
            city: "Bordeaux",
            department: "33",
          },
          match: {
            marketDiscountPct: 31.6,
            reasons: ["Mise à prix basse", "DPE C"],
          },
        },
      },
    });

    expect(message.to).toBe("client@example.test");
    expect(message.subject).toContain("Maison judiciaire");
    expect(message.unsubscribeUrl).toBe(
      "https://immojudis.example/api/notification-preferences/unsubscribe?notificationId=6b6b42a1-b719-48cc-9c9f-f0c9f707e17d",
    );
    expect(message.text).toContain("ni une promesse de gain");
    expect(message.html).toContain("Se désinscrire des alertes email");
  });

  it("passes a supervised-agent reply address to Resend", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "email_1" }),
    );

    await sendResendEmail({
      apiKey: "re_test",
      idempotencyKey: "mission-1",
      fetchImpl: fetchMock as unknown as typeof fetch,
      message: {
        from: "Assistant ImmoJudis <assistant@immojudis.fr>",
        to: "cabinet@example.test",
        replyTo: "utilisateur@example.test",
        subject: "Demande d'informations",
        html: "<p>Bonjour</p>",
        text: "Bonjour",
      },
    });

    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      reply_to: "utilisateur@example.test",
    });
  });
});
