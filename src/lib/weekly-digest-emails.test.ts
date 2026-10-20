import { describe, expect, it } from "vitest";
import { emailClickPath, readEmailClickToken } from "@/lib/email-click-token";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import {
  buildWeeklyDigestMessage,
  weeklyDigestIsEmpty,
  weeklyDigestSubject,
  type WeeklyDigestContent,
} from "@/lib/weekly-digest-emails";

const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" };
const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const saleId = "A1B2C3D4-0000-4000-8000-000000000001";
const now = new Date("2026-11-03T10:30:00Z");

const content: WeeklyDigestContent = {
  audiences: [
    {
      saleId,
      title: "Maison à Bordeaux",
      location: "Tribunal judiciaire de Bordeaux",
      detail: "Audience : mardi 10 novembre 2026 à 14 h 00",
    },
  ],
  audiencesMore: 0,
  changes: [
    {
      saleId: "a1b2c3d4-0000-4000-8000-000000000002",
      title: "Appartement à Lyon",
      location: "",
      label: "Mise à prix abaissée",
      detail: "Montants à confirmer.",
    },
  ],
  changesMore: 2,
  newSales: {
    departments: ["33"],
    total: 6,
    items: [
      {
        saleId: "a1b2c3d4-0000-4000-8000-000000000003",
        title: "Maison à Pessac",
        location: "Département 33",
        detail: null,
      },
    ],
  },
  hasAlert: true,
};

function build(overrides: Partial<WeeklyDigestContent> = {}, internal = false) {
  return buildWeeklyDigestMessage({
    userId,
    content: { ...content, ...overrides },
    recipientEmail: "investisseur@example.test",
    from: "Immojudis <alertes@immojudis.com>",
    appUrl: "https://immojudis.com",
    internal,
    now,
    env,
  });
}

function trackedLinks(text: string) {
  return [...text.matchAll(/https:\/\/immojudis\.com\/api\/email\/click\?token=\S+/g)].map(
    ([url]) => {
      const read = readEmailClickToken(new URL(url).searchParams.get("token"), { now, env });
      if (!read) throw new Error("Lien suivi illisible.");
      return { url, claims: read.claims };
    },
  );
}

describe("email du récapitulatif hebdomadaire", () => {
  it("présente les trois rubriques, l'audience avec la mention à vérifier", () => {
    const message = build();
    expect(message.subject).toBe(
      "Ma semaine sur Immojudis : 1 audience, 3 changements, 6 nouvelles ventes",
    );
    expect(message.text).toContain("Vos audiences des 14 prochains jours");
    expect(message.text).toContain("Audience : mardi 10 novembre 2026 à 14 h 00");
    expect(message.text).toContain("à vérifier auprès de l’avocat poursuivant");
    expect(message.text).toContain("Ce qui a changé sur vos ventes suivies (7 derniers jours)");
    expect(message.text).toContain("Mise à prix abaissée : Appartement à Lyon");
    expect(message.text).toContain("… et 2 autres : https://immojudis.com/favoris");
    expect(message.text).toContain(
      "Nouvelles ventes dans votre département (33), 6 ventes en 7 jours",
    );
    expect(message.text).toContain("Maison à Pessac - Département 33");
    expect(message.html).toContain("Vos audiences des 14 prochains jours");
    expect(message.html).toContain("Voir l'annonce");
  });

  it("n'affiche ni prix, ni montant, ni adresse", () => {
    const message = build();
    expect(`${message.subject}\n${message.text}\n${message.html}`).not.toMatch(/€|euros?\b/i);
  });

  it("omet les rubriques vides", () => {
    const message = build({
      changes: [],
      changesMore: 0,
      newSales: { departments: [], total: 0, items: [] },
      hasAlert: true,
    });
    expect(message.subject).toBe("Ma semaine sur Immojudis : 1 audience");
    expect(message.text).not.toContain("Ce qui a changé");
    expect(message.text).not.toContain("Nouvelles ventes dans");
    expect(message.html).not.toContain("Ce qui a changé");
  });

  it("refuse de construire un email sans contenu", () => {
    const empty: Partial<WeeklyDigestContent> = {
      audiences: [],
      changes: [],
      newSales: { departments: ["33"], total: 0, items: [] },
    };
    expect(weeklyDigestIsEmpty({ ...content, ...empty })).toBe(true);
    expect(() => build(empty)).toThrow("Aucun contenu");
  });

  it("n'annonce que les rubriques non vides dans l'objet", () => {
    expect(
      weeklyDigestSubject(
        { ...content, changes: [], changesMore: 0, newSales: { ...content.newSales, total: 0 } },
        false,
      ),
    ).toBe("Ma semaine sur Immojudis : 1 audience");
    expect(weeklyDigestSubject(content, true).startsWith("[Test interne] ")).toBe(true);
  });

  it("met le lien de désinscription signé, de portée dédiée, dans le texte, le HTML et l'en-tête", () => {
    const message = build();
    const url = new URL(message.unsubscribeUrl);
    expect(url.origin + url.pathname).toBe(
      "https://immojudis.com/api/notification-preferences/unsubscribe",
    );
    const claims = verifyUnsubscribeToken(url.searchParams.get("token"), { now, env });
    expect(claims).toMatchObject({ userId, scope: { kind: "weekly-digest" } });
    expect(message.text).toContain(`Se désinscrire du récapitulatif : ${message.unsubscribeUrl}`);
    expect(message.html).toContain("Se désinscrire du récapitulatif");
    expect(message.html).toContain(message.unsubscribeUrl.replace(/&/g, "&amp;"));
    expect(message.oneClickUnsubscribe).toBe(true);
    expect(message.text).toContain("https://immojudis.com/compte");
  });

  it("suit les liens des ventes par la redirection signée de type « weekly »", () => {
    const message = build();
    const links = trackedLinks(message.text);
    // Annonce + agenda de l'audience, annonce du changement, annonce de la nouvelle vente.
    expect(links).toHaveLength(4);
    expect(links.every(({ claims }) => claims.kind === "weekly" && claims.userId === userId)).toBe(
      true,
    );
    expect(links.map(({ claims }) => emailClickPath(claims))).toEqual([
      "/sales/a1b2c3d4-0000-4000-8000-000000000001",
      "/api/sales/a1b2c3d4-0000-4000-8000-000000000001/calendar",
      "/sales/a1b2c3d4-0000-4000-8000-000000000002",
      "/sales/a1b2c3d4-0000-4000-8000-000000000003",
    ]);
  });

  it("garde un lien direct pour un identifiant de vente qui n'est pas un UUID", () => {
    const message = build({
      audiences: [{ saleId: "pas-un-uuid", title: "Bien", location: "", detail: null }],
    });
    expect(message.text).toContain("https://immojudis.com/sales/pas-un-uuid");
  });

  it("propose « Créer une alerte » seulement sans alerte active", () => {
    expect(build({ hasAlert: true }).text).not.toContain("Créer une alerte");
    expect(build({ hasAlert: true }).html).not.toContain("Créer une alerte");
    const without = build({ hasAlert: false });
    expect(without.text).toContain("Créer une alerte : https://immojudis.com/alertes");
    expect(without.html).toContain(">Créer une alerte</a>");
    expect(without.html).toContain('href="https://immojudis.com/alertes"');
  });

  it("échappe le contenu dans le HTML", () => {
    const message = build({
      audiences: [
        {
          saleId,
          title: "<script>alert(1)</script>",
          location: 'Tribunal "x" & cie',
          detail: null,
        },
      ],
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("&amp; cie");
  });
});
