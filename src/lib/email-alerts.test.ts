import { describe, expect, it, vi } from "vitest";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import {
  buildAlertDigestMessage,
  resolveEmailAlertDeliveryConfig,
  sendResendEmail,
} from "@/lib/email-alerts";

describe("email alerts", () => {
  it("requires Resend, sender and canonical app URL before dispatching", () => {
    expect(resolveEmailAlertDeliveryConfig({})).toMatchObject({
      configured: false,
      missing: ["RESEND_API_KEY", "ALERT_EMAIL_FROM", "SITE_URL"],
    });

    expect(
      resolveEmailAlertDeliveryConfig({
        RESEND_API_KEY: "re_test",
        ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.fr>",
        NEXT_PUBLIC_APP_URL: "https://immojudis.example/",
      }),
    ).toMatchObject({
      configured: true,
      appUrl: "https://immojudis.example",
    });
  });

  it("prefers SITE_URL and keeps NEXT_PUBLIC_APP_URL as a fallback", () => {
    const base = { RESEND_API_KEY: "re_test", ALERT_EMAIL_FROM: "Immojudis <a@immojudis.fr>" };
    expect(
      resolveEmailAlertDeliveryConfig({
        ...base,
        SITE_URL: "https://canonical.example",
        NEXT_PUBLIC_APP_URL: "https://legacy.example",
      }).appUrl,
    ).toBe("https://canonical.example");
    expect(
      resolveEmailAlertDeliveryConfig({ ...base, NEXT_PUBLIC_APP_URL: "https://legacy.example" })
        .appUrl,
    ).toBe("https://legacy.example");
  });

  const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" };
  const userId = "7d335032-e935-4550-9347-ed22b0f63449";
  const alertA = "11111111-2222-4333-8444-555555555555";
  const notification = (
    id: string,
    saleId: string,
    title: string,
    saleFacts: { saleDate?: string; startingPriceEur?: number } = {},
  ) => ({
    id,
    alert_id: alertA,
    sale_id: saleId,
    notification_snapshot: {
      alert: { id: alertA, name: "Bordeaux décoté" },
      sale: { id: saleId, title, city: "Bordeaux", department: "33", ...saleFacts },
      match: { marketDiscountPct: 31.6, reasons: ["Mise à prix basse", "DPE C"] },
    },
  });

  it("builds one compliant digest for all the sales found for a user", () => {
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      now: new Date("2026-10-09T10:00:00Z"),
      env,
      notifications: [
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", "sale-1", "Maison judiciaire"),
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17e", "sale-2", "Appartement T3"),
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17f", "sale-3", "Studio"),
      ],
    });

    expect(message.to).toBe("client@example.test");
    expect(message.subject).toBe("Alerte Immojudis — 3 ventes correspondent à vos alertes");
    expect(message.text.startsWith("Bonjour,")).toBe(true);
    expect(message.html).toContain("Bonjour,");
    expect(message.text).not.toContain("ImmoJudis");
    expect(message.html).not.toContain("ImmoJudis");
    for (const title of ["Maison judiciaire", "Appartement T3", "Studio"]) {
      expect(message.text).toContain(title);
      expect(message.html).toContain(title);
    }
    expect(message.text).toContain("ni une promesse de gain");
    expect(message.html).toContain("Se désinscrire des alertes email");
    expect(message.oneClickUnsubscribe).toBe(true);

    const token = new URL(message.unsubscribeUrl).searchParams.get("token");
    expect(message.unsubscribeUrl).toContain("/api/notification-preferences/unsubscribe?token=");
    expect(
      verifyUnsubscribeToken(token, { now: new Date("2026-10-09T10:00:00Z"), env }),
    ).toMatchObject({
      userId,
      scope: { kind: "alerts" },
    });
    // Per-alert link in addition to the global one.
    expect(message.text).toContain("Désactiver cette alerte");
  });

  it("shows the hearing date and the starting price of each sale when the snapshot has them", () => {
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      env,
      notifications: [
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", "sale-1", "Maison judiciaire", {
          saleDate: "2026-11-12T13:00:00.000Z",
          startingPriceEur: 95000,
        }),
      ],
    });

    expect(message.subject).toBe(
      "Alerte Immojudis — Maison judiciaire (Bordeaux · 33), audience le 12 novembre 2026",
    );
    expect(message.text).toContain("Audience : 12 novembre 2026 · Mise à prix : 95");
    expect(message.text).toMatch(/Mise à prix : 95\s000\s€/);
    expect(message.html).toContain("Audience : 12 novembre 2026");
  });

  it("leaves the facts line out when the snapshot has neither a date nor a price", () => {
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      env,
      notifications: [
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", "sale-1", "Maison judiciaire"),
      ],
    });

    expect(message.subject).toBe("Alerte Immojudis — Maison judiciaire (Bordeaux · 33)");
    expect(message.text).not.toContain("Audience :");
    expect(message.text).not.toContain("Mise à prix :");
  });

  it("caps the list and points to the alerts page for the rest", () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      notification(
        `6b6b42a1-b719-48cc-9c9f-f0c9f707e1${(index + 10).toString(16).padStart(2, "0").slice(-2)}`,
        `sale-${index}`,
        `Vente ${index}`,
      ),
    );
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      env,
      notifications: many,
    });
    expect(message.subject).toContain("14 ventes");
    expect(message.text).toContain("… et 4 autres ventes");
    expect(message.text).not.toContain("Vente 13");
  });

  it("sends the one-click unsubscribe headers to Resend", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "email_2" }),
    );
    await sendResendEmail({
      apiKey: "re_test",
      idempotencyKey: "digest-1",
      fetchImpl: fetchMock as unknown as typeof fetch,
      message: {
        from: "Immojudis <alertes@immojudis.fr>",
        to: "client@example.test",
        subject: "Alerte",
        html: "<p>x</p>",
        text: "x",
        unsubscribeUrl:
          "https://immojudis.example/api/notification-preferences/unsubscribe?token=t",
        oneClickUnsubscribe: true,
      },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.headers).toEqual({
      "List-Unsubscribe":
        "<https://immojudis.example/api/notification-preferences/unsubscribe?token=t>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
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
        from: "Assistant Immojudis <assistant@immojudis.fr>",
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
