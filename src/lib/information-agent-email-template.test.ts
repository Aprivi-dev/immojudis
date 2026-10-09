import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  INFORMATION_AGENT_ACCOUNT_INVITATION_CTA,
  INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING,
  informationAgentEmailTemplateContentSchema,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";

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
  questions: "- Le cahier des conditions de vente est-il disponible ?",
};

describe("information agent email content template", () => {
  it("renders fixed and dynamic blocks with only whitelisted variables", () => {
    const rendered = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
    });

    expect(rendered.subject).toBe("Appartement T3 à Bordeaux — précisions pour Immojudis");
    expect(rendered.bodyText).toContain("Bonjour Maître Dupont");
    expect(rendered.bodyText).toContain(
      "Immojudis est un service indépendant qui aide les acquéreurs à mieux préparer les ventes judiciaires.",
    );
    expect(rendered.bodyText).toContain(
      "Une réponse même partielle nous aide à présenter un dossier plus clair et à limiter les demandes répétées.",
    );
    expect(rendered.bodyText).toContain("Audience annoncée : 14 septembre 2026");
    expect(rendered.bodyText).toContain("cahier des conditions de vente");
    expect(rendered.bodyText).toContain("Aucun compte n’est nécessaire.");
    expect(rendered.bodyText).toContain(INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING);
    expect(rendered.bodyText).toContain(
      `${INFORMATION_AGENT_ACCOUNT_INVITATION_CTA} : https://immojudis.com/login?mode=professional&redirect=%2Fespace-pro`,
    );
    expect(rendered.bodyText.match(/Vous avez d’autres ventes à partager \?/g)).toHaveLength(1);
    expect(rendered.bodyText).toContain("Bien cordialement");
    expect(rendered.bodyText).toContain("documents ou photos");
    expect(rendered.bodyText).toContain(
      "Un simple retour à cet email suffit, avec les documents ou photos que vous êtes autorisé à partager.",
    );
    expect(rendered.bodyText).toContain("Aucun compte n’est nécessaire.");
    expect(rendered.bodyText).not.toContain("JPG ou PNG");
    expect(rendered.bodyText).not.toContain("plusieurs emails");
    expect(rendered.bodyText).not.toContain("vidéo");
    expect(rendered.bodyText).not.toContain("utilisateur intéressé");
    expect(rendered.bodyText).not.toContain("{{");
  });

  it("adds the protected invitation to a legacy seven-block template before closing", () => {
    const legacyTemplate = structuredClone(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE);
    legacyTemplate.name = "Demande d’informations — modèle initial";
    legacyTemplate.subjectTemplate = "Demande d’informations — {{sale_title}}";
    legacyTemplate.blocks = legacyTemplate.blocks.map((block) => {
      if (block.id === "identity") {
        return {
          ...block,
          content:
            "Immojudis est un service indépendant d’analyse des ventes immobilières judiciaires. Nous vous contactons au sujet de cette vente.",
        };
      }
      if (block.id === "reply_instructions") {
        return {
          ...block,
          content:
            "Vous pouvez répondre directement à cet email et y joindre les documents ou photographies que vous êtes autorisé à communiquer.",
        };
      }
      return block;
    });

    const rendered = renderInformationAgentEmailContent({
      template: legacyTemplate,
      values,
      appUrl: "https://staging.immojudis.com",
    });

    const invitationIndex = rendered.bodyText.indexOf(INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING);
    const closingIndex = rendered.bodyText.indexOf("Bien cordialement");
    expect(invitationIndex).toBeGreaterThan(-1);
    expect(invitationIndex).toBeLessThan(closingIndex);
    expect(rendered.bodyText).toContain(
      "https://staging.immojudis.com/login?mode=professional&redirect=%2Fespace-pro",
    );
    expect(rendered.bodyText.match(/Vous avez d’autres ventes à partager \?/g)).toHaveLength(1);
    expect(rendered.bodyText).toContain("Nous vous contactons au sujet de cette vente.");
  });

  it("accepts an already-built account URL", () => {
    const rendered = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
      accountUrl: "https://staging.immojudis.com/professional/start",
    });

    expect(rendered.bodyText).toContain(
      "Créer un compte professionnel : https://staging.immojudis.com/professional/start",
    );
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
