import { describe, expect, it, vi } from "vitest";
import { escapeHtml } from "@/lib/guards";
import { PEPITE_EXPLANATION } from "@/lib/pepite-copy";
import { emailClickPath, readEmailClickToken } from "@/lib/email-click-token";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import {
  buildAlertDigestMessage,
  resolveEmailAlertDeliveryConfig,
  resolveReplyTo,
  resolveTransactionalEmailConfig,
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

  it("sends billing and acceptance messages from TRANSACTIONAL_EMAIL_FROM, falling back to the alerts sender", () => {
    const base = {
      RESEND_API_KEY: "re_test",
      NEXT_PUBLIC_APP_URL: "https://immojudis.example",
    };
    // Sans variable dédiée : l'expéditeur des alertes, comme avant.
    expect(
      resolveTransactionalEmailConfig({
        ...base,
        ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.fr>",
      }).from,
    ).toBe("Immojudis <alertes@immojudis.fr>");
    // Avec elle : l'expéditeur séparé, et l'expéditeur des alertes n'est plus requis.
    const separate = resolveTransactionalEmailConfig({
      ...base,
      TRANSACTIONAL_EMAIL_FROM: "Immojudis <compte@immojudis.fr>",
    });
    expect(separate).toMatchObject({
      configured: true,
      from: "Immojudis <compte@immojudis.fr>",
      missing: [],
    });
    // Les alertes, elles, gardent leur expéditeur.
    expect(
      resolveEmailAlertDeliveryConfig({
        ...base,
        ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.fr>",
        TRANSACTIONAL_EMAIL_FROM: "Immojudis <compte@immojudis.fr>",
      }).from,
    ).toBe("Immojudis <alertes@immojudis.fr>");
    // Sans aucun des deux : non configuré, l'expéditeur des alertes est cité.
    expect(resolveTransactionalEmailConfig(base).missing).toContain("ALERT_EMAIL_FROM");
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
    expect(message.text).toContain(
      "Mise à prix inférieure d’environ 32 % à la référence DVF (indicatif : hors frais, travaux et occupation)",
    );
    expect(message.text).not.toContain("Décote estimée");
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

  it("pour une alerte « Seulement les pépites » : la mention en texte, sans aucun montant, avec le lien vers la méthode", () => {
    const pepiteNotification = {
      ...notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e1aa", "sale-p", "Maison judiciaire", {
        saleDate: "2026-11-20T09:00:00Z",
      }),
      notification_snapshot: {
        alert: { id: alertA, name: "Pépites de Bordeaux" },
        sale: { id: "sale-p", title: "Maison judiciaire", city: "Bordeaux", department: "33" },
        // Le motif « pépite » vient de l'évaluation de l'alerte ; jamais de montant dans le snapshot.
        match: { marketDiscountPct: null, reasons: ["pépite", "DPE C"] },
      },
    };
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      now: new Date("2026-10-09T10:00:00Z"),
      env,
      notifications: [pepiteNotification],
    });

    // Le texte validé le 26/10, mot pour mot, dans le texte comme dans le HTML.
    expect(message.text).toContain(`Pépite : ${PEPITE_EXPLANATION}`);
    expect(message.html).toContain(escapeHtml(PEPITE_EXPLANATION));
    expect(message.text).toContain(
      "Comment repérons-nous les pépites ? https://immojudis.example/methode-pepites",
    );
    expect(message.html).toContain("<strong>Pépite</strong>");
    expect(message.html).toContain('href="https://immojudis.example/methode-pepites"');
    // Le mot n'est pas répété dans la liste des critères détectés ; les autres critères y restent.
    expect(message.text).toContain("Critères détectés : DPE C");
    expect(message.text).not.toMatch(/Critères détectés : [^\n]*pépite/);
    // Aucun montant de pépite : ni plafond, ni prix probable, ni fourchette.
    expect(`${message.text}\n${message.html}`).not.toMatch(
      /plafond|prix probable|fourchette|\d[\d\s\u00a0\u202f]*€/i,
    );
  });

  it("cite la carte des loyers de l'ANIL, avec son lien, quand une alerte filtre sur le rendement", () => {
    const yieldNotification = {
      ...notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e1bb", "sale-y", "Studio"),
      notification_snapshot: {
        alert: { id: alertA, name: "Rendement" },
        sale: { id: "sale-y", title: "Studio", city: "Bordeaux", department: "33" },
        match: { marketDiscountPct: null, reasons: ["rendement"] },
      },
    };
    const build = (notifications: unknown[]) =>
      buildAlertDigestMessage({
        userId,
        from: "Immojudis <alertes@immojudis.fr>",
        recipientEmail: "client@example.test",
        appUrl: "https://immojudis.example",
        now: new Date("2026-10-09T10:00:00Z"),
        env,
        notifications: notifications as Parameters<
          typeof buildAlertDigestMessage
        >[0]["notifications"],
      });

    const message = build([yieldNotification]);
    for (const body of [message.text, message.html]) {
      expect(body).toContain(
        "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
      );
      expect(body).toContain("charges comprises");
      expect(body).toContain("Licence Ouverte 2.0");
      expect(body).toContain("sous sa seule responsabilité");
      expect(body).toContain("https://www.data.gouv.fr/datasets/693aa2feed1bf4da603faa49");
    }
    // Le pied reste avant les liens de désinscription, et sans la mention pour une alerte sans rendement.
    expect(message.text.indexOf("Estimations ANIL")).toBeLessThan(
      message.text.indexOf("Se désinscrire de tous les emails d'alerte"),
    );
    const other = build([notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", "sale-1", "Maison")]);
    expect(other.text).not.toContain("ANIL");
    expect(other.html).not.toContain("ANIL");
  });

  it("n'ajoute rien pour une vente qui ne vient pas d'une alerte « pépites »", () => {
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      now: new Date("2026-10-09T10:00:00Z"),
      env,
      notifications: [notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", "sale-1", "Maison")],
    });
    expect(message.text).not.toMatch(/pépite/i);
    expect(message.html).not.toMatch(/pépite/i);
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

  it("sends the sale links through the signed click redirect (measure per account)", () => {
    const saleId = "A1B2C3D4-0000-4000-8000-000000000001";
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      now: new Date("2026-10-09T10:00:00Z"),
      env,
      notifications: [
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", saleId, "Maison judiciaire"),
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17e", "sale-2", "Studio"),
      ],
    });

    const links = [
      ...message.text.matchAll(/https:\/\/immojudis\.example\/api\/email\/click\?token=\S+/g),
    ].map(([url]) => url);
    // Seul l'identifiant qui est un UUID est suivi ; l'autre garde son lien direct.
    expect(links).toHaveLength(1);
    expect(message.text).toContain("https://immojudis.example/sales/sale-2");
    const url = new URL(links[0]);
    expect([...url.searchParams.keys()]).toEqual(["token"]);
    const read = readEmailClickToken(url.searchParams.get("token"), {
      now: new Date("2026-10-09T10:00:00Z"),
      env,
    });
    expect(read?.expired).toBe(false);
    expect(read?.claims).toMatchObject({ userId, kind: "alert", target: "sale" });
    expect(emailClickPath(read!.claims)).toBe("/sales/a1b2c3d4-0000-4000-8000-000000000001");
    expect(message.html).toContain(links[0]);
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

  it("tells the recipient why the digest arrives: alert name and activation date, title and preheader", () => {
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      env,
      alertActivatedAt: new Map([[alertA, "2026-10-12T08:00:00Z"]]),
      notifications: [
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", "sale-1", "Maison judiciaire", {
          saleDate: "2026-11-12T13:00:00Z",
          startingPriceEur: 95_000,
        }),
      ],
    });
    const reason =
      "Vous recevez ce message parce que vous avez activé l’alerte « Bordeaux décoté » le 12 octobre 2026.";
    expect(message.text).toContain(reason);
    expect(message.html).toContain(reason);
    expect(message.html).toContain(`<title>${message.subject}</title>`);
    // Le pré-en-tête est masqué dans le message et reprend l'audience et la mise à prix.
    expect(message.html).toMatch(/display:none[^>]*>Audience : 12 novembre 2026 · Mise à prix/);
    // En-tête de marque et plus de Georgia.
    expect(message.html).toContain("Immojudis</span>");
    expect(message.html).not.toContain("Georgia");
    expect(message.html).toContain("Manrope");
  });

  it("names every alert of a digest, and keeps the name alone when its date is unknown", () => {
    const message = buildAlertDigestMessage({
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      env,
      notifications: [
        notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17d", "sale-1", "Maison judiciaire"),
        {
          ...notification("6b6b42a1-b719-48cc-9c9f-f0c9f707e17e", "sale-2", "Studio"),
          alert_id: "22222222-2222-4333-8444-555555555555",
          notification_snapshot: {
            alert: { id: "22222222-2222-4333-8444-555555555555", name: "Lyon" },
            sale: { id: "sale-2", title: "Studio", city: "Lyon", department: "69" },
            match: { reasons: [] },
          },
        },
      ],
      alertActivatedAt: new Map([[alertA, "2026-10-12T08:00:00Z"]]),
    });
    expect(message.text).toContain(
      "parce que vous avez activé les alertes « Bordeaux décoté » (le 12 octobre 2026), « Lyon ».",
    );
  });

  it("does not send a Discovery account to the alerts list for « … et N autres »", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      notification(
        `6b6b42a1-b719-48cc-9c9f-f0c9f707e1${(index + 10).toString(16).padStart(2, "0").slice(-2)}`,
        `sale-${index}`,
        `Vente ${index}`,
      ),
    );
    const input = {
      userId,
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "client@example.test",
      appUrl: "https://immojudis.example",
      env,
      notifications: many,
    };
    const discovery = buildAlertDigestMessage({ ...input, audience: "discovery" });
    expect(discovery.text).toContain(
      "… et 2 autres ventes correspondent à vos alertes (catalogue) : https://immojudis.example/sales",
    );
    expect(discovery.text).not.toContain(
      "… et 2 autres ventes : https://immojudis.example/alertes",
    );
    expect(discovery.html).toContain('href="https://immojudis.example/sales"');
    // Un compte Analyse garde la liste de ses alertes.
    const analysis = buildAlertDigestMessage({ ...input, audience: "analyse" });
    expect(analysis.text).toContain("… et 2 autres ventes : https://immojudis.example/alertes");
  });

  it("tags every Resend send with its category", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "email_tag" }),
    );
    await sendResendEmail({
      apiKey: "re_test",
      idempotencyKey: "tag-1",
      fetchImpl: fetchMock as unknown as typeof fetch,
      category: "billing",
      message: {
        from: "Immojudis <compte@immojudis.fr>",
        to: "client@example.test",
        subject: "Paiement",
        html: "<p>x</p>",
        text: "x",
      },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.tags).toEqual([{ name: "category", value: "billing" }]);
  });

  it("sends the one-click unsubscribe headers to Resend", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "email_2" }),
    );
    await sendResendEmail({
      apiKey: "re_test",
      idempotencyKey: "digest-1",
      fetchImpl: fetchMock as unknown as typeof fetch,
      category: "alert",
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

  describe("reply-to", () => {
    const send = async (replyTo?: string | null) => {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ id: "email_3" }),
      );
      await sendResendEmail({
        apiKey: "re_test",
        idempotencyKey: "reply-to",
        fetchImpl: fetchMock as unknown as typeof fetch,
        category: "alert",
        message: {
          from: "Immojudis <alertes@immojudis.fr>",
          to: "client@example.test",
          ...(replyTo === undefined ? {} : { replyTo }),
          subject: "Alerte",
          html: "<p>x</p>",
          text: "x",
        },
      });
      return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    };

    it("resolves EMAIL_REPLY_TO first, then the published contact address, else nothing", () => {
      expect(
        resolveReplyTo({
          EMAIL_REPLY_TO: " contact@immojudis.example ",
          NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "autre@immojudis.example",
        }),
      ).toBe("contact@immojudis.example");
      expect(resolveReplyTo({ NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "autre@immojudis.example" })).toBe(
        "autre@immojudis.example",
      );
      expect(resolveReplyTo({ EMAIL_REPLY_TO: "pas une adresse" })).toBeNull();
      expect(resolveReplyTo({})).toBeNull();
    });

    it("adds the site reply address to emails that name none, and keeps an explicit one", async () => {
      vi.stubEnv("EMAIL_REPLY_TO", "contact@immojudis.example");
      try {
        expect(await send()).toMatchObject({ reply_to: "contact@immojudis.example" });
        expect(await send("agent@reponses.immojudis.example")).toMatchObject({
          reply_to: "agent@reponses.immojudis.example",
        });
        // `null` : volontairement aucune adresse de réponse.
        expect(await send(null)).not.toHaveProperty("reply_to");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("sends no reply-to when none is configured", async () => {
      vi.stubEnv("EMAIL_REPLY_TO", "");
      vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "");
      try {
        expect(await send()).not.toHaveProperty("reply_to");
      } finally {
        vi.unstubAllEnvs();
      }
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
      category: "alert",
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
