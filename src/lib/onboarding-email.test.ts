import { describe, expect, it } from "vitest";
import { verifyUnsubscribeToken } from "./email-unsubscribe-token";
import {
  buildOnboardingMessage,
  ONBOARDING_CATALOGUE_LABEL,
  ONBOARDING_REASON,
  ONBOARDING_SUBJECT,
  ONBOARDING_UNLOCK_RETURNED_TEXT,
  ONBOARDING_UNSUBSCRIBE_LABEL,
  onboardingSubject,
} from "./onboarding-email";
import { UNLOCK_CONFIRMATION_TEXT } from "./sale-unlock-panel-texts";
import {
  FREE_SALE_UNLOCKS,
  UNLOCK_CALL_TO_ACTION_LABEL,
  UNLOCK_HIGHLIGHTS_INLINE_TEXT,
} from "./sale-unlocks";

const env = { EMAIL_UNSUBSCRIBE_SECRET: "secret-de-test" };
const userId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const now = new Date("2026-11-27T13:30:00Z");
const APP = "https://immojudis.test";

function build(overrides: { internal?: boolean; department?: string | null } = {}) {
  return buildOnboardingMessage({
    userId,
    department: overrides.department === undefined ? "33" : overrides.department,
    recipientEmail: "claire@example.test",
    from: "Immojudis <compte@immojudis.test>",
    appUrl: APP,
    internal: overrides.internal,
    now,
    env,
  });
}

/** Le texte visible du message : objet, HTML sans balises et texte brut, espaces normalisés. */
function visibleText(message: Awaited<ReturnType<typeof build>>): string {
  const html = message.html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&zwnj;/g, " ");
  return `${message.subject}\n${html}\n${message.text}`.replace(/\s+/g, " ");
}

/** Toutes les adresses des liens du HTML. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll("&amp;", "&"));
}

describe("objet", () => {
  it("annonce le déblocage compris dans le compte, et le dit en mode d'essai", () => {
    expect(ONBOARDING_SUBJECT).toBe("Votre compte Immojudis comprend le déblocage d’une vente");
    expect(onboardingSubject(false)).toBe(ONBOARDING_SUBJECT);
    expect(onboardingSubject(true)).toBe(`[Test interne] ${ONBOARDING_SUBJECT}`);
  });
});

describe("contenu : la prise en main du déblocage, rien d'autre", () => {
  it("dit ce qu'est le déblocage, ce qu'il ouvre, qu'il est unique, quand il est rendu et où le retrouver", () => {
    const message = build();
    for (const body of [message.text, visibleText(message)]) {
      const flat = body.replace(/\s+/g, " ");
      expect(flat).toContain("Votre compte gratuit comprend le déblocage d’une vente.");
      expect(flat).toContain(UNLOCK_HIGHLIGHTS_INLINE_TEXT);
      expect(flat).toContain("Votre compte comprend un seul déblocage.");
      expect(flat).toContain(`« ${UNLOCK_CALL_TO_ACTION_LABEL} »`);
      expect(flat).toContain(ONBOARDING_UNLOCK_RETURNED_TEXT);
      expect(flat).toContain("« Mon compte »");
      expect(flat).toContain("« Mes ventes débloquées »");
      expect(flat).toContain("Ce message est le seul que nous vous envoyons à ce sujet.");
    }
  });

  it("reprend les textes de l'écran du déblocage, sans les réécrire", () => {
    // « un seul déblocage » n'est vrai que tant que le compte gratuit n'en compte qu'un.
    expect(FREE_SALE_UNLOCKS).toBe(1);
    // La phrase « quand il est rendu » est celle de la carte de déblocage de la fiche.
    expect(UNLOCK_CONFIRMATION_TEXT.endsWith(ONBOARDING_UNLOCK_RETURNED_TEXT)).toBe(true);
  });

  it("ne contient aucun élément commercial : ni prix, ni « Analyse », ni /offres, ni urgence", () => {
    for (const message of [build(), build({ department: null }), build({ internal: true })]) {
      const body = visibleText(message);
      // Prix et argent.
      expect(body).not.toMatch(
        /€|\beuros?\b|\bprix\b|\btarif|payant|paiement|abonn|\bachat|achet|à l’unité|\bcrédit/i,
      );
      // Offre payante : le nom de l'offre (avec sa majuscule) et la page des offres.
      expect(body).not.toMatch(/\bAnalyse\b/);
      expect(body).not.toMatch(/\bessai\b|\bpremium\b|\bremise\b|réduction|promotion/i);
      expect(`${message.html}\n${message.text}`).not.toContain("/offres");
      // Urgence et compte à rebours.
      expect(body).not.toMatch(
        /dernière chance|plus que|\bvite\b|urgent|limité|expire|dès maintenant|maintenant|aujourd’hui|ce soir|\bjours? restants?|il ne reste|ne tardez|avant qu’il ne soit trop tard/i,
      );
    }
  });

  it("ne met aucune vente en avant : un seul lien vers une page du site, le catalogue filtré sur le département", () => {
    const message = build();
    const pages = hrefs(message.html).filter((href) => !href.startsWith("mailto:"));
    expect(pages).toEqual([`${APP}/sales?department=33`, message.unsubscribeUrl]);
    expect(message.text).toContain(`${ONBOARDING_CATALOGUE_LABEL} : ${APP}/sales?department=33`);
    expect(visibleText(message)).toContain("département de votre première alerte, Gironde (33)");
    // Aucune fiche de vente.
    expect(`${message.html}\n${message.text}`).not.toMatch(/\/sales\/[0-9a-f-]{8,}/i);
  });

  it("ouvre le catalogue entier sans alerte, ou quand le département est inconnu", () => {
    for (const department of [null, "999", ""]) {
      const message = build({ department });
      const pages = hrefs(message.html).filter((href) => !href.startsWith("mailto:"));
      expect(pages, String(department)).toEqual([`${APP}/sales`, message.unsubscribeUrl]);
      expect(message.text).toContain(`${ONBOARDING_CATALOGUE_LABEL} : ${APP}/sales\n`);
      expect(message.text).not.toContain("première alerte");
    }
  });
});

describe("pied, opposition et mode d'essai", () => {
  it("dit au pied pourquoi la personne le reçoit, en HTML et en texte", () => {
    const message = build();
    expect(ONBOARDING_REASON).toBe("Message unique de prise en main de votre compte Immojudis.");
    const footer = message.html.slice(message.html.lastIndexOf('class="ej-pad ej-rule"'));
    expect(footer).toContain(ONBOARDING_REASON);
    expect(footer).toContain(ONBOARDING_UNSUBSCRIBE_LABEL);
    expect(message.text).toContain(ONBOARDING_REASON);
  });

  it("porte un lien d'opposition signé, en un clic, aussi en en-tête, propre à ce message", () => {
    const message = build();
    expect(message.oneClickUnsubscribe).toBe(true);
    expect(message.replyTo).toBeNull();
    const url = new URL(message.unsubscribeUrl);
    expect(url.origin + url.pathname).toBe(`${APP}/api/notification-preferences/unsubscribe`);
    expect(verifyUnsubscribeToken(url.searchParams.get("token"), { now, env })).toMatchObject({
      userId,
      scope: { kind: "onboarding-email" },
    });
    expect(message.text).toContain(`${ONBOARDING_UNSUBSCRIBE_LABEL} : ${message.unsubscribeUrl}`);
  });

  it("prévient en tête du mode d'essai, et seulement alors", () => {
    const internal = build({ internal: true });
    expect(internal.subject).toMatch(/^\[Test interne\] /);
    expect(internal.text.startsWith("Test interne")).toBe(true);
    expect(internal.html).toContain("Test interne");
    const real = build();
    expect(real.subject).not.toContain("Test interne");
    expect(real.html).not.toContain("Test interne");
  });

  it("n'écrit ni l'adresse ni l'identifiant de la personne dans le HTML en dehors du lien signé", () => {
    const message = build();
    expect(message.html).not.toContain("claire@example.test");
    expect(message.html).not.toContain(userId);
    expect(message.to).toBe("claire@example.test");
  });
});
