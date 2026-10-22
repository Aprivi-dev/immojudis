import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";
import {
  assertNoInformationAgentCommercialMention,
  findInformationAgentCommercialMentions,
  normalizeInformationAgentGuardText,
} from "@/lib/information-agent-commercial-guard";
import {
  INFORMATION_AGENT_QUESTIONS,
  buildInformationRequestDraft,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent";
import { renderInformationRequestEmail } from "../../emails/information-request";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

const APP_URL = "https://immojudis.example";
const values = {
  recipient_name: "Maître Dupont",
  salutation: "Bonjour Maître Dupont,",
  sale_title: "Appartement T3 à Bordeaux",
  sale_subject_title: "Appartement T3 à Bordeaux",
  sale_reference: "Appartement T3 à Bordeaux — 33000 Bordeaux — Tribunal judiciaire de Bordeaux",
  location: "33000 Bordeaux",
  tribunal: "Tribunal judiciaire de Bordeaux",
  hearing_date: "14 septembre 2026",
  hearing_line: "Audience annoncée : 14 septembre 2026",
  subject_date: "audience du 14/09/2026",
  starting_price: "85 000 €",
  price_line: "Mise à prix annoncée : 85 000 €",
  questions: Object.values(INFORMATION_AGENT_QUESTIONS)
    .map((question) => `- ${question.question}`)
    .join("\n"),
};

describe("aucune mention commerciale dans le message de l'agent (cadrage juridique 7.8)", () => {
  it("le gabarit par défaut, avec toutes les questions possibles, ne contient aucune mention commerciale", () => {
    const rendered = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
    });
    expect(findInformationAgentCommercialMentions(rendered.subject)).toEqual([]);
    expect(findInformationAgentCommercialMentions(rendered.bodyText)).toEqual([]);
    for (const block of DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.blocks) {
      expect(findInformationAgentCommercialMentions(block.content)).toEqual([]);
    }
  });

  it("le brouillon de chaque question reste purement informatif", () => {
    for (const key of Object.keys(INFORMATION_AGENT_QUESTIONS) as InformationAgentQuestionKey[]) {
      const draft = buildInformationRequestDraft({
        sale: {
          id: "sale",
          title: "Appartement T3 à Bordeaux",
          city: "Bordeaux",
          postal_code: "33000",
          tribunal: "Tribunal judiciaire de Bordeaux",
          sale_date: "2026-09-14",
          starting_price_eur: 85000,
        } as never,
        recipientName: "Maître Dupont",
        questionKeys: [key],
      });
      expect(findInformationAgentCommercialMentions(draft.subject), key).toEqual([]);
      expect(findInformationAgentCommercialMentions(draft.bodyText), key).toEqual([]);
    }
  });

  it("le message rendu (HTML et texte), pied et liens compris, ne contient aucune mention commerciale", async () => {
    const { bodyText, subject } = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
    });
    const email = await renderInformationRequestEmail({
      subject,
      bodyText,
      replyTo: "enquete+jeton@reponses.immojudis.example",
      caseReference: "IJ-ABC123",
      appUrl: APP_URL,
      contributionUrl: `${APP_URL}/contribuer/jeton-prive`,
      legalFooter: {
        controllerName: "Immojudis SAS",
        controllerAddress: "1 rue de la Paix, 75002 Paris",
        contactEmail: "contact@immojudis.example",
        saleReference: "Appartement T3 à Bordeaux",
        addressOrigin:
          "Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor (https://www.licitor.com/annonce/1), consultée le 14/10/2026.",
        addressOriginUrl: "https://www.licitor.com/annonce/1",
        automatedSearch: true,
        aiProvider: { id: "replicate", name: "Replicate", country: "États-Unis" },
        privacyUrl: `${APP_URL}/privacy`,
        optOutUrl: `${APP_URL}/api/information-agent/opt-out?e=abc&t=def`,
      },
    });
    for (const output of [email.html, email.text]) {
      expect(
        findInformationAgentCommercialMentions(output, {
          appOrigin: APP_URL,
          allowedUrls: ["https://www.licitor.com/annonce/1"],
          ignore: ["Appartement T3 à Bordeaux"],
        }),
      ).toEqual([]);
    }
    // Plus de présentation du service ni de lien vers le site : l'identité tient au pied du message.
    for (const output of [email.html, email.text]) {
      expect(output).not.toContain("Service indépendant d’aide à l’analyse");
      expect(output).not.toContain("Ventes immobilières aux enchères : tribunal, notaire, État");
      expect(output).not.toMatch(/>immojudis\.com</);
    }
  });

  it.each([
    ["offer", "Découvrez nos offres pour les professionnels."],
    ["offer", "Notre offre Analyse est disponible."],
    ["offer", "Souscrivez un abonnement."],
    ["offer", "Un essai gratuit est possible."],
    ["offer", "Nous cherchons un partenaire pour ce secteur."],
    ["offer", "Proposons un partenariat entre nos structures."],
    ["offer", "Une mise en relation avec des acquéreurs est possible."],
    ["offer", "Notre plateforme vous apporte de la clientèle."],
    ["offer", "Inscrivez-vous à la newsletter."],
    ["offer", "Nous vous proposons une démonstration."],
    ["account", "Créez un compte professionnel Immojudis."],
    ["account", "Créer un compte gratuit pour nous transmettre vos ventes."],
    ["account", "Inscrivez-vous sur Immojudis."],
    ["account", "L'inscription gratuite prend une minute."],
    ["promotion", "Bénéficiez d'une mise en avant de vos ventes."],
    ["promotion", "Nous pouvons référencer votre cabinet."],
    ["promotion", "Ce service sponsorisé est réservé aux avocats."],
    ["price", "À partir de 29 € par mois."],
    ["price", "Nos tarifs sont publics."],
    ["price", "Le tarif d'Immojudis est de 29 euros HT."],
    ["price", "Notre prix est attractif."],
  ])("refuse la mention %s : %s", (rule, text) => {
    const mentions = findInformationAgentCommercialMentions(text);
    expect(mentions.map((mention) => mention.rule)).toContain(rule);
    expect(() => assertNoInformationAgentCommercialMention(text)).toThrow(
      "aucune mention commerciale",
    );
  });

  it("n'écarte pas à tort le vocabulaire de la vente et les termes juridiques courants", () => {
    for (const text of [
      "Pouvez-vous confirmer la mise à prix applicable à ce lot ?",
      "Les mises à prix des lots 1 et 2 sont-elles confirmées ?",
      "Quel est le prix de départ, et le prix atteint à l'audience précédente ?",
      "Le prix d'adjudication sera-t-il publié ? Quel est le prix de réserve ?",
      "Quelle est la date limite de dépôt des offres ?",
      "Une offre d'achat a-t-elle été déposée ?",
      "Une inscription hypothécaire ou une inscription au rôle est-elle en cours ?",
      "La publicité de la vente et la publicité foncière ont-elles été faites ?",
      "Quels sont les émoluments et les frais annoncés, en HT ou TTC ?",
      "Quelle est la visibilité du bien depuis la rue ? C'est une promotion immobilière.",
      "Le forfait de consignation et le pack de diagnostics sont-ils joints ?",
      "Quel est le tarif du droit de plaidoirie ?",
      "Le lieu ou la plateforme de vente est-il confirmé ?",
      "Aucun compte n’est nécessaire.",
      "Vous pouvez déposer vos pièces sans créer de compte.",
      "Quelles sont les modalités d'inscription aux visites ?",
      "Ce message ne contient aucune offre commerciale.",
      "Référence de suivi : IJ-ABC123",
      "Votre adresse professionnelle figure sur votre fiche publique de l’annuaire des avocats du Conseil national des barreaux.",
    ]) {
      expect(findInformationAgentCommercialMentions(text), text).toEqual([]);
    }
  });

  it("résiste aux contournements simples (caractères invisibles, entités, espaces insécables)", () => {
    for (const text of [
      "Une mise\u200b en avant de vos ventes",
      "Une mise\u00a0en\u00a0avant de vos ventes",
      "Cr\u00adéez un compte professionnel",
      "Abonne\u2060ment annuel",
      "<p>Nos&nbsp;tarifs sont publics</p>",
    ]) {
      expect(findInformationAgentCommercialMentions(text).length, text).toBeGreaterThan(0);
    }
  });

  it("écarte du contrôle les textes issus de l'annonce, sans affaiblir le reste", () => {
    const html = "<p>Vente : Résidence Premium, forfait inclus. Créez un compte.</p>";
    const mentions = findInformationAgentCommercialMentions(html, {
      ignore: ["Résidence Premium, forfait inclus"],
    });
    expect(mentions.map((mention) => mention.excerpt)).toEqual(["Créez un compte"]);
  });

  it.each([
    `${APP_URL}/offres`,
    `${APP_URL}/offres?utm_source=agent`,
    `${APP_URL}/login?mode=professional`,
    `${APP_URL}/inscription`,
    `${APP_URL}/avocats`,
    `${APP_URL}/offres/analyse`,
    `${APP_URL}/`,
    "https://www.immojudis.example/offres",
    "http://immojudis.example:8080/offres",
    "https://immojudis.example.evil.test/privacy",
    "https://annonces-concurrent.example.test/vente",
    "https://www.licitor.com/autre-page",
  ])("refuse le lien : %s", (link) => {
    const options = { appOrigin: APP_URL, allowedUrls: ["https://www.licitor.com/annonce/1"] };
    expect(
      findInformationAgentCommercialMentions(`Voir ${link}`, options).map(
        (mention) => mention.rule,
      ),
    ).toContain("link");
    expect(
      findInformationAgentCommercialMentions(`<p><a href="${link}">Voir</a></p>`, options).map(
        (mention) => mention.rule,
      ),
    ).toContain("link");
    // Attribut entre apostrophes.
    expect(
      findInformationAgentCommercialMentions(`<a href='${link}'>Voir</a>`, options).map(
        (mention) => mention.rule,
      ),
    ).toContain("link");
  });

  it.each([
    `${APP_URL}/privacy`,
    `https://www.immojudis.example/privacy`,
    `${APP_URL}/contribuer/abc123`,
    `${APP_URL}/api/information-agent/opt-out?e=a&t=b`,
    "https://www.cnil.fr/fr/plaintes",
    "https://www.licitor.com/annonce/1",
    "https://www.licitor.com/annonce/1/",
  ])("admet le lien utile au destinataire : %s", (link) => {
    const options = { appOrigin: APP_URL, allowedUrls: ["https://www.licitor.com/annonce/1"] };
    expect(findInformationAgentCommercialMentions(`Voir ${link}`, options)).toEqual([]);
    expect(findInformationAgentCommercialMentions(`<a href="${link}">Voir</a>`, options)).toEqual(
      [],
    );
  });

  it("refuse tout lien quand aucune origine ni source n'est fournie", () => {
    expect(findInformationAgentCommercialMentions("Voir https://example.test/page")).toHaveLength(
      1,
    );
    expect(findInformationAgentCommercialMentions("Écrire à contact@example.test")).toEqual([]);
  });

  it("décode les entités une seule fois : &amp;nbsp; et &amp;quot; restent littéraux", () => {
    expect(normalizeInformationAgentGuardText("a&amp;nbsp;b")).toBe("a&nbsp;b");
    expect(normalizeInformationAgentGuardText("a&amp;quot;b")).toBe("a&quot;b");
    expect(normalizeInformationAgentGuardText("a&amp;amp;b")).toBe("a&amp;b");
    expect(normalizeInformationAgentGuardText("a&nbsp;b&quot;c&#x27;d&amp;e")).toBe("a b\"c'd&e");
    // Une entité doublement encodée ne fabrique pas un espace qui masquerait « mise en avant ».
    expect(findInformationAgentCommercialMentions("mise&amp;nbsp;en&amp;nbsp;avant")).toEqual([]);
    expect(findInformationAgentCommercialMentions("mise&nbsp;en&nbsp;avant")).toHaveLength(1);
  });
});
