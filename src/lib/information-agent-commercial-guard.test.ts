import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";
import {
  assertNoInformationAgentCommercialMention,
  findInformationAgentCommercialMentions,
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
  starting_price: "85 000 €",
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
      expect(findInformationAgentCommercialMentions(output, { appOrigin: APP_URL })).toEqual([]);
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
    ["account", "Créez un compte professionnel Immojudis."],
    ["account", "Créer un compte gratuit pour nous transmettre vos ventes."],
    ["account", "Inscrivez-vous sur Immojudis."],
    ["promotion", "Bénéficiez d'une mise en avant de vos ventes."],
    ["promotion", "Gagnez en visibilité auprès des acquéreurs."],
    ["price", "À partir de 29 € par mois."],
    ["price", "Le tarif est de 29 euros HT."],
    ["price", "Notre prix est attractif."],
  ])("refuse la mention %s : %s", (rule, text) => {
    const mentions = findInformationAgentCommercialMentions(text);
    expect(mentions.map((mention) => mention.rule)).toContain(rule);
    expect(() => assertNoInformationAgentCommercialMention(text)).toThrow(
      "aucune mention commerciale",
    );
  });

  it.each([
    `${APP_URL}/offres`,
    `${APP_URL}/offres?utm_source=agent`,
    `${APP_URL}/login?mode=professional`,
    `${APP_URL}/inscription`,
    `${APP_URL}/avocats`,
    "https://www.immojudis.example/offres",
    `${APP_URL}/offres/analyse`,
  ])("refuse le lien vers le site : %s", (link) => {
    const mentions = findInformationAgentCommercialMentions(`Voir ${link}`, { appOrigin: APP_URL });
    expect(mentions.map((mention) => mention.rule)).toContain("link");
    const html = `<p><a href="${link}">Voir</a></p>`;
    expect(
      findInformationAgentCommercialMentions(html, { appOrigin: APP_URL }).map(
        (mention) => mention.rule,
      ),
    ).toContain("link");
  });

  it.each([
    `${APP_URL}/privacy`,
    `${APP_URL}/contribuer/abc123`,
    `${APP_URL}/api/information-agent/opt-out?e=a&t=b`,
    `${APP_URL}/agent-information`,
    "https://www.licitor.com/offres-speciales",
    "https://www.cnil.fr/fr/plaintes",
  ])("admet le lien utile au destinataire : %s", (link) => {
    expect(findInformationAgentCommercialMentions(`Voir ${link}`, { appOrigin: APP_URL })).toEqual(
      [],
    );
  });

  it("admet les formules qui décrivent la vente ou rassurent le destinataire", () => {
    for (const text of [
      "Pouvez-vous confirmer la mise à prix applicable à ce lot ?",
      "Quelle est la date limite de dépôt des offres ?",
      "Une offre d'achat a-t-elle été déposée ?",
      "Aucun compte n’est nécessaire.",
      "Vous pouvez déposer vos pièces sans créer de compte.",
      "Quelles sont les modalités d'inscription aux visites ?",
      "Ce message ne contient aucune offre commerciale.",
      "Le prix d'adjudication sera-t-il publié ?",
      "Référence de suivi : IJ-ABC123",
    ]) {
      expect(findInformationAgentCommercialMentions(text), text).toEqual([]);
    }
  });
});
