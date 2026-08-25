import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  informationAgentEmailTemplateContentSchema,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";

const values = {
  recipient_name: "Maître Dupont",
  sale_title: "Appartement T3 à Bordeaux",
  sale_reference: "Appartement T3 à Bordeaux — 33000 Bordeaux — Tribunal judiciaire de Bordeaux",
  location: "33000 Bordeaux",
  tribunal: "Tribunal judiciaire de Bordeaux",
  hearing_date: "14 septembre 2026",
  starting_price: "85 000 €",
  questions: "- Le cahier des conditions de vente est-il disponible ?",
};

describe("information agent email content template", () => {
  it("renders fixed and dynamic blocks with only whitelisted variables", () => {
    const rendered = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
    });

    expect(rendered.subject).toContain("Appartement T3 à Bordeaux");
    expect(rendered.bodyText).toContain("Bonjour Maître Dupont");
    expect(rendered.bodyText).toContain("cahier des conditions de vente");
    expect(rendered.bodyText).not.toContain("{{");
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
