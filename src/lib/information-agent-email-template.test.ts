import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  containsInformationAgentAccountInvitation,
  INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING,
  informationAgentEmailTemplateContentSchema,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";
import { INFORMATION_AGENT_QUESTIONS } from "@/lib/information-agent-questions";

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
  questions: "- Le cahier des conditions de vente est-il disponible ?",
};

describe("information agent email content template", () => {
  it("la question sur les modalités distingue la garantie pour enchérir du paiement du prix (art. R. 322-41)", () => {
    const question = INFORMATION_AGENT_QUESTIONS.sale_terms.question;
    expect(question).toContain("la garantie à remettre avant d'enchérir");
    expect(question).toContain("10 % de la mise à prix, 3 000 € au minimum");
    expect(question).toContain("chèque de banque ou caution bancaire");
    expect(question).toContain("dont celui de paiement du prix");
    // « consignation » désigne le dépôt du prix après la vente, pas la garantie.
    expect(question).not.toContain("consignation");
  });

  it("nomme le gabarit par défaut en version 10", () => {
    expect(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.name).toBe(
      "Demande de précisions sur une vente — version 10",
    );
  });

  it("renders fixed and dynamic blocks with only whitelisted variables", () => {
    const rendered = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
    });

    expect(rendered.subject).toBe(
      "Appartement T3 à Bordeaux, audience du 14/09/2026 : vérification de l’annonce",
    );
    expect(rendered.bodyText).toContain("Bonjour Maître Dupont");
    // Qui écrit, en une phrase factuelle : sans elle, le message ressemble à de l'hameçonnage.
    expect(rendered.bodyText).toContain(
      "Immojudis est un site privé d’information sur les ventes immobilières aux enchères",
    );
    expect(rendered.bodyText).toContain("n’agit pas au nom d’un tribunal");
    // Pas d'adjectif non vérifiable dans la phrase d'identité, ni de « consignation » pour la garantie.
    expect(rendered.bodyText).not.toContain("indépendant");
    expect(rendered.bodyText).not.toContain("consignation");
    expect(rendered.bodyText).toContain("Audience annoncée : 14 septembre 2026");
    expect(rendered.bodyText).toContain("Mise à prix annoncée : 85 000 €");
    expect(rendered.bodyText).toContain("Une réponse même partielle nous est utile");
    expect(rendered.bodyText).toContain("cahier des conditions de vente");
    // Le caractère facultatif ouvre les consignes au lieu d'être noyé au milieu.
    expect(rendered.bodyText).toContain("Répondre est facultatif.");
    expect(rendered.bodyText).toContain("documents ou photos que vous êtes autorisé à partager");
    expect(rendered.bodyText).toContain("Aucun compte n’est nécessaire.");
    expect(rendered.bodyText).toContain("votre secret professionnel prime sur notre demande");
    expect(rendered.bodyText).not.toContain(INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING);
    expect(rendered.bodyText).toContain("Bien cordialement");
    expect(rendered.bodyText).not.toContain("utilisateur intéressé");
    expect(rendered.bodyText).not.toContain("{{");
  });

  it("never adds the professional-account invitation (prospecting) to a request", () => {
    const rendered = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
      appUrl: "https://staging.immojudis.com",
    });

    expect(rendered.bodyText).not.toContain(INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING);
    expect(rendered.bodyText).not.toContain("Créer un compte professionnel");
    expect(rendered.bodyText).not.toContain("mode=professional");
    expect(rendered.bodyText).toContain("Bien cordialement");
  });

  it("strips the legacy invitation that older published templates still contain", () => {
    const legacyTemplate = structuredClone(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE);
    legacyTemplate.blocks = legacyTemplate.blocks.map((block) =>
      block.id === "closing"
        ? {
            ...block,
            content: [
              "POUR LES PROFESSIONNELS",
              INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING,
              "Vous pouvez créer un compte professionnel ImmoJudis.",
              "Créer un compte professionnel : https://immojudis.com/login?mode=professional",
              "",
              "Vous publiez d’autres ventes ? Un compte professionnel Immojudis vous permet de nous les transmettre directement.",
              "",
              "Bien cordialement,",
            ].join("\n"),
          }
        : block,
    );

    const rendered = renderInformationAgentEmailContent({ template: legacyTemplate, values });

    expect(containsInformationAgentAccountInvitation(rendered.bodyText)).toBe(false);
    expect(rendered.bodyText).toContain("Bien cordialement");
    expect(rendered.bodyText).not.toContain("POUR LES PROFESSIONNELS");
    expect(rendered.bodyText).not.toContain("Vous publiez d’autres ventes");
  });

  it("rejects unknown variables and removal of the questions placeholder", () => {
    const unknownVariable = structuredClone(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE);
    unknownVariable.blocks[0].content = "Bonjour {{secret_key}}";
    expect(informationAgentEmailTemplateContentSchema.safeParse(unknownVariable).success).toBe(
      false,
    );

    const missingQuestions = structuredClone(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE);
    missingQuestions.blocks.find((block) => block.id === "questions")!.content = "Questions";
    expect(informationAgentEmailTemplateContentSchema.safeParse(missingQuestions).success).toBe(
      false,
    );
  });

  it("does not allow a fixed block to become dynamic", () => {
    const changedKind = structuredClone(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE);
    changedKind.blocks.find((block) => block.id === "identity")!.kind = "dynamic";
    expect(informationAgentEmailTemplateContentSchema.safeParse(changedKind).success).toBe(false);
  });
});
