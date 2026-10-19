import { describe, expect, it } from "vitest";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import {
  buildSaleReminderMessage,
  saleReminderSubject,
  type SaleReminderItem,
} from "@/lib/sale-reminder-emails";

const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" };
const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const saleId = "A1B2C3D4-0000-4000-8000-000000000001";
const now = new Date("2026-11-03T06:00:00Z");

const week: SaleReminderItem = {
  kind: "audience_j7",
  saleId,
  title: "Maison à Bordeaux",
  location: "Tribunal judiciaire de Bordeaux",
  headline: "Votre audience est dans 7 jours",
  detail: "Audience : mardi 10 novembre 2026 à 14 h 00",
};
const eve: SaleReminderItem = {
  ...week,
  kind: "audience_j1",
  headline: "Votre audience est demain",
};
const moved: SaleReminderItem = {
  kind: "date_changed",
  saleId: "a1b2c3d4-0000-4000-8000-000000000002",
  title: "Appartement à Lyon",
  location: "",
  headline: "La date de l’audience a changé",
  detail: "Nouvelle date à confirmer auprès de l’avocat poursuivant.",
};

function build(items: SaleReminderItem[], internal = false) {
  return buildSaleReminderMessage({
    userId,
    items,
    recipientEmail: "investisseur@example.test",
    from: "Immojudis <alertes@immojudis.com>",
    appUrl: "https://immojudis.com",
    internal,
    now,
    env,
  });
}

describe("email des rappels d'audience", () => {
  it("nomme l'échéance dans l'objet quand il n'y a qu'un rappel", () => {
    expect(saleReminderSubject([week], false)).toBe(
      "Votre audience est dans 7 jours — Maison à Bordeaux (Tribunal judiciaire de Bordeaux)",
    );
    expect(saleReminderSubject([eve], false)).toContain("Votre audience est demain");
    expect(saleReminderSubject([moved], false)).toBe(
      "La date de l’audience a changé — Appartement à Lyon",
    );
  });

  it("compte les rappels dans l'objet quand il y en a plusieurs", () => {
    expect(saleReminderSubject([week, moved], false)).toBe(
      "Vos ventes suivies : 2 rappels et changements",
    );
  });

  it("préfixe l'objet en mode d'essai interne", () => {
    expect(saleReminderSubject([week], true).startsWith("[Test interne] ")).toBe(true);
    expect(build([week], true).subject.startsWith("[Test interne] ")).toBe(true);
    expect(build([week]).subject.startsWith("[Test interne]")).toBe(false);
  });

  it("garde la date, la mention à vérifier et les liens vers la fiche et l'agenda", () => {
    const message = build([week]);
    expect(message.text).toContain("Audience : mardi 10 novembre 2026 à 14 h 00");
    expect(message.text).toContain("à vérifier auprès de l’avocat poursuivant");
    expect(message.html).toContain("à vérifier auprès de l’avocat poursuivant");
    // L'identifiant de la vente est écrit en minuscules, comme l'adresse canonique de la fiche.
    expect(message.text).toContain(
      "https://immojudis.com/sales/a1b2c3d4-0000-4000-8000-000000000001",
    );
    expect(message.text).toContain(
      "https://immojudis.com/api/sales/a1b2c3d4-0000-4000-8000-000000000001/calendar",
    );
    expect(message.html).toContain("Voir l'annonce");
    expect(message.html).toContain("Ajouter à mon agenda");
  });

  it("n'ajoute pas d'export d'agenda à un avertissement de changement, et mentionne l'avocat", () => {
    const message = build([moved]);
    expect(message.text).not.toContain("/calendar");
    expect(message.html).not.toContain("Ajouter à mon agenda");
    expect(message.text).toContain("avocat poursuivant");
  });

  it("signe le lien de désinscription pour la portée « rappels » et l'annonce en un clic", () => {
    const message = build([week, moved]);
    const url = new URL(message.unsubscribeUrl);
    expect(url.pathname).toBe("/api/notification-preferences/unsubscribe");
    expect(verifyUnsubscribeToken(url.searchParams.get("token"), { now, env })).toMatchObject({
      userId,
      scope: { kind: "reminders" },
    });
    expect(message.oneClickUnsubscribe).toBe(true);
    expect(message.text).toContain(`Se désinscrire des rappels : ${message.unsubscribeUrl}`);
    expect(message.text).toContain("https://immojudis.com/compte");
    expect(message.text).toContain("vous avez activé les rappels d'audience");
  });

  it("échappe le HTML des libellés", () => {
    const message = build([{ ...week, title: "<script>alert(1)</script>", location: "A & B" }]);
    expect(message.html).not.toContain("<script>alert(1)</script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("A &amp; B");
  });

  it("refuse de construire un email sans rappel", () => {
    expect(() => build([])).toThrow("Aucun rappel à envoyer.");
  });
});
