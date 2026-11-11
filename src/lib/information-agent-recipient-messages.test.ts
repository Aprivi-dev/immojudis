import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INFORMATION_AGENT_OBJECTION_STATEMENT,
  INFORMATION_AGENT_STRUCTURE_OBJECTION_SCOPE_STATEMENT,
  informationAgentAddressOrigin,
  informationAgentLegalFooterLines,
  type InformationAgentLegalFooter,
} from "@/lib/information-agent-compliance";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
  type InformationAgentEmailTemplateContent,
} from "@/lib/information-agent-email-template";
import { INFORMATION_AGENT_QUESTIONS } from "@/lib/information-agent-questions";
import {
  assertInformationAgentNotarySendAllowed,
  INFORMATION_AGENT_NOTARY_SEND_DISABLED_MESSAGE,
} from "@/lib/information-agent/config";
import {
  assertInformationAgentQuestionsAllowed,
  INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS,
  INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE,
  informationAgentQuestionAudience,
  informationAgentQuestionTextFor,
  isInformationAgentQuestionAllowed,
} from "@/lib/information-agent/recipient-questions";
import {
  informationAgentAudienceInvitesDocuments,
  informationAgentAudienceTemplate,
  NOTARY_EMAIL_TEMPLATE,
  STATE_SERVICE_EMAIL_TEMPLATE,
} from "@/lib/information-agent/recipient-templates";

describe("destinataire des questions : le rôle établi, sinon l'organisateur de la vente", () => {
  it("rôle établi", () => {
    expect(
      informationAgentQuestionAudience({ role: "lawyer", organizerType: "pursuing_lawyer" }),
    ).toBe("lawyer");
    expect(informationAgentQuestionAudience({ role: "notary", organizerType: "notary" })).toBe(
      "notary",
    );
    expect(
      informationAgentQuestionAudience({
        role: "organizer",
        structureKind: "state_service",
        organizerType: "state_service",
      }),
    ).toBe("state_service");
  });

  it.each([null, "source_contact", "organizer", "manual_professional"])(
    "rôle non établi (%s) : liste courte sur une vente notariale ou une cession, inchangé ailleurs",
    (role) => {
      expect(informationAgentQuestionAudience({ role, organizerType: "notary" })).toBe("notary");
      expect(informationAgentQuestionAudience({ role, organizerType: "state_service" })).toBe(
        "state_service",
      );
      expect(informationAgentQuestionAudience({ role, organizerType: "pursuing_lawyer" })).toBe(
        "other",
      );
      expect(informationAgentQuestionAudience({ role, organizerType: "unknown" })).toBe("other");
    },
  );

  it("un notaire désigné reste un notaire même si l'organisateur de la vente est inconnu", () => {
    expect(informationAgentQuestionAudience({ role: "notary", organizerType: "unknown" })).toBe(
      "notary",
    );
  });
});

describe("questions admises", () => {
  it("notaire et service de l'État : liste courte fermée ; avocat : inchangé", () => {
    expect(INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS).toEqual([
      "surface",
      "composition",
      "occupancy",
      "visit",
      "documents",
    ]);
    expect(INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE.notary).toBe(
      INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS,
    );
    expect(INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE.state_service).toBe(
      INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS,
    );
    expect([...INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE.lawyer].sort()).toEqual(
      Object.keys(INFORMATION_AGENT_QUESTIONS).sort(),
    );
    expect(informationAgentQuestionTextFor("lawyer", "documents")).toBe(
      INFORMATION_AGENT_QUESTIONS.documents.question,
    );
    for (const key of ["sale_date", "starting_price_eur", "sale_terms", "diagnostics"] as const) {
      expect(isInformationAgentQuestionAllowed("notary", key)).toBe(false);
      expect(() => informationAgentQuestionTextFor("state_service", key)).toThrow("non admise");
    }
  });

  it("occupation : le notaire répond selon l'annonce ou le cahier des charges, sans le loyer", () => {
    expect(informationAgentQuestionTextFor("notary", "occupancy")).toBe(
      "Selon l’annonce ou le cahier des charges, le bien est-il libre, occupé ou loué ?",
    );
    expect(informationAgentQuestionTextFor("state_service", "occupancy")).toBe(
      "Le bien est-il actuellement libre, occupé ou loué ?",
    );
    expect(informationAgentQuestionTextFor("lawyer", "occupancy")).toContain("loyer");
  });

  it("relecture à l'aperçu et à l'envoi : liste courte rejouée, valeur inconnue refusée", () => {
    expect(() =>
      assertInformationAgentQuestionsAllowed("notary", ["surface", "visit"]),
    ).not.toThrow();
    expect(() =>
      assertInformationAgentQuestionsAllowed("notary", ["surface", "sale_terms"]),
    ).toThrow("l'agent ne demande que la surface");
    expect(() => assertInformationAgentQuestionsAllowed("state_service", ["photos"])).toThrow(
      "l'agent ne demande que la surface",
    );
    // Avocat et brouillons antérieurs : inchangé, même avec une ancienne clé.
    expect(() => assertInformationAgentQuestionsAllowed("lawyer", ["sale_terms"])).not.toThrow();
    expect(() => assertInformationAgentQuestionsAllowed("other", ["surface_m2"])).not.toThrow();
    for (const unknown of ["tout_le_monde", null, 3]) {
      expect(() => assertInformationAgentQuestionsAllowed(unknown, [])).toThrow("non reconnu");
    }
  });
});

describe("texte du message selon le destinataire", () => {
  const values = {
    recipient_name: "Madame, Monsieur",
    salutation: "Madame, Monsieur,",
    sale_title: "Maison",
    sale_subject_title: "Maison à Bordeaux",
    sale_reference: "Maison — 3 rue des Vignes — 33000 Bordeaux",
    location: "33000 Bordeaux",
    tribunal: "Tribunal non précisé",
    hearing_date: "14/12/2026",
    hearing_line: "Audience annoncée : 14/12/2026",
    subject_date: "audience du 14/12/2026",
    starting_price: "100 000 €",
    price_line: "Mise à prix annoncée : 100 000 €",
    questions: INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS.map(
      (key) => `- ${informationAgentQuestionTextFor("notary", key)}`,
    ).join("\n"),
  };
  const render = (template: InformationAgentEmailTemplateContent) => {
    const rendered = renderInformationAgentEmailContent({ template, values });
    return `${rendered.subject}\n${rendered.bodyText}`;
  };

  it("un modèle par destinataire ; l'avocat garde le modèle publié", () => {
    expect(informationAgentAudienceTemplate("notary")).toBe(NOTARY_EMAIL_TEMPLATE);
    expect(informationAgentAudienceTemplate("state_service")).toBe(STATE_SERVICE_EMAIL_TEMPLATE);
    expect(informationAgentAudienceTemplate("lawyer")).toBeNull();
    expect(informationAgentAudienceTemplate("other")).toBeNull();
  });

  it("notaire : ni pièces de procédure, ni garantie, ni audience, ni invitation à joindre", () => {
    const message = render(NOTARY_EMAIL_TEMPLATE);
    expect(message).toContain(
      "Répondre est facultatif. Nous ne demandons que des informations déjà destinées aux candidats acquéreurs : celles de l’annonce et du cahier des charges. Ne nous transmettez rien d’autre : votre secret professionnel prime sur notre demande.",
    );
    // Même avec une date d'audience et une mise à prix connues, le message ne les reprend pas.
    expect(message).not.toMatch(
      /cahier des conditions de vente|procès-verbal descriptif|garantie|audience|mise à prix|documents ou photos|joindre|diagnostics/i,
    );
    expect(message).toContain("Maison à Bordeaux : vérification de l’annonce");
    expect(message).toContain("Vente concernée : Maison — 3 rue des Vignes — 33000 Bordeaux");
    // Le modèle des avocats, lui, cite ces pièces : la différence est bien dans le modèle.
    expect(render(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE)).toMatch(
      /cahier des conditions de vente.*procès-verbal descriptif/s,
    );
    expect(informationAgentAudienceInvitesDocuments("notary")).toBe(false);
    for (const audience of ["lawyer", "state_service", "other"]) {
      expect(informationAgentAudienceInvitesDocuments(audience)).toBe(true);
    }
  });

  it("service de l'État : les règles de l'administration priment, pas de secret professionnel", () => {
    const message = render(STATE_SERVICE_EMAIL_TEMPLATE);
    expect(message).toContain(
      "Répondre est facultatif. Nous ne demandons que des informations déjà destinées aux candidats à l’acquisition. Les règles de votre administration priment sur notre demande.",
    );
    expect(message).not.toMatch(
      /secret professionnel|cahier des conditions de vente|procès-verbal descriptif|garantie|audience|mise à prix/i,
    );
  });
});

describe("envois aux notaires fermés par défaut", () => {
  const notary = { role: "notary", questionAudience: "notary" };

  it("refuse tant que le réglage n'est pas exactement `true`", () => {
    for (const env of [{}, { INFORMATION_AGENT_NOTARY_SEND_ENABLED: "false" }]) {
      expect(() => assertInformationAgentNotarySendAllowed(notary, env)).toThrow(
        INFORMATION_AGENT_NOTARY_SEND_DISABLED_MESSAGE,
      );
    }
    for (const value of ["1", "TRUE", "oui", " true"]) {
      expect(() =>
        assertInformationAgentNotarySendAllowed(notary, {
          INFORMATION_AGENT_NOTARY_SEND_ENABLED: value,
        }),
      ).toThrow("Envoi à un notaire fermé");
    }
    expect(() =>
      assertInformationAgentNotarySendAllowed(notary, {
        INFORMATION_AGENT_NOTARY_SEND_ENABLED: "true",
      }),
    ).not.toThrow();
  });

  it("vaut pour le rôle notaire et pour tout destinataire d'une vente notariale, pas pour les autres", () => {
    expect(() =>
      assertInformationAgentNotarySendAllowed({ role: null, questionAudience: "notary" }, {}),
    ).toThrow("Envoi à un notaire fermé");
    expect(() =>
      assertInformationAgentNotarySendAllowed({ role: "notary", questionAudience: "other" }, {}),
    ).toThrow("Envoi à un notaire fermé");
    for (const recipient of [
      { role: "lawyer", questionAudience: "lawyer" },
      { role: "organizer", questionAudience: "state_service" },
      { role: null, questionAudience: "other" },
    ]) {
      expect(() => assertInformationAgentNotarySendAllowed(recipient, {})).not.toThrow();
    }
  });
});

describe("pied du message, variante « structure »", () => {
  const footer = (
    overrides: Partial<InformationAgentLegalFooter>,
  ): InformationAgentLegalFooter => ({
    controllerName: "Immojudis SAS",
    controllerAddress: "1 rue de la Paix, 33000 Bordeaux",
    contactEmail: "contact@immojudis.example",
    addressOrigin: "Origine.",
    aiProvider: { name: "Replicate", country: "États-Unis" } as never,
    privacyUrl: "https://immojudis.example/privacy",
    optOutUrl: "https://immojudis.example/api/information-agent/opt-out",
    ...overrides,
  });

  it("origine : « l'adresse de contact de votre étude (ou de votre service) », pour l'annonce seulement", () => {
    const listing = {
      sourceKind: "sale_listing" as const,
      sourceName: "licitor",
      sourceUrl: "https://annonces.example.test/licitor/1",
      observedAt: "2026-11-10T08:00:00Z",
      observedBy: "agent" as const,
    };
    const structure = informationAgentAddressOrigin({ ...listing, structureAddress: true });
    expect(structure.text).toBe(
      "L’adresse de contact de votre étude (ou de votre service) figure dans l’annonce publique de cette vente sur Licitor (https://annonces.example.test/licitor/1), consultée le 10/11/2026.",
    );
    expect(structure.structureAddress).toBe(true);
    const person = informationAgentAddressOrigin(listing);
    expect(person.text).toContain("Votre adresse professionnelle figure dans l’annonce publique");
    expect(person.structureAddress).toBeUndefined();
    // Un greffe garde sa propre variante.
    const court = informationAgentAddressOrigin({
      sourceKind: "court_registry_fallback",
      structureAddress: true,
    });
    expect(court.courtRegistry).toBe(true);
    expect(court.structureAddress).toBeUndefined();
  });

  it("catégories de données et portée de l'opposition", () => {
    const structure = informationAgentLegalFooterLines(
      footer({ structureAddress: true, structureOpposition: true }),
    ).join("\n");
    expect(structure).toContain(
      "Vos données : l’adresse de contact de votre étude, de votre cabinet ou de votre service et, si vous répondez, le nom, la fonction et les coordonnées de la personne qui répond, ainsi que nos échanges. Origine : Origine.",
    );
    expect(structure).toContain(
      `Opposition : ${INFORMATION_AGENT_OBJECTION_STATEMENT} ${INFORMATION_AGENT_STRUCTURE_OBJECTION_SCOPE_STATEMENT}`,
    );
    expect(INFORMATION_AGENT_STRUCTURE_OBJECTION_SCOPE_STATEMENT).toBe(
      "Si vous vous opposez depuis l’adresse de contact d’une étude, d’un cabinet ou d’un service, nous n’écrirons plus à aucune adresse de cette structure.",
    );

    const person = informationAgentLegalFooterLines(footer({})).join("\n");
    expect(person).toContain(
      "Vos données : votre nom, votre fonction, votre adresse professionnelle",
    );
    expect(person).not.toContain("aucune adresse de cette structure");

    // Adresse générique sans structure identifiable : catégories « structure », aucune promesse de portée.
    const unknownStructure = informationAgentLegalFooterLines(
      footer({ structureAddress: true, structureOpposition: false }),
    ).join("\n");
    expect(unknownStructure).toContain("l’adresse de contact de votre étude, de votre cabinet");
    expect(unknownStructure).not.toContain("aucune adresse de cette structure");
  });
});

describe("la mesure à blanc n'est exposée par aucune route", () => {
  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);
      return statSync(full).isDirectory() ? files(full) : [full];
    });

  it("aucun fichier de `src/app` n'importe `information-agent/dry-run`", () => {
    const app = path.resolve(process.cwd(), "src/app");
    const sources = files(app).filter((file) => /\.(?:ts|tsx)$/.test(file));
    expect(sources.length).toBeGreaterThan(50);
    const importers = sources.filter((file) =>
      /information-agent\/dry-run|measureInformationAgentRecipients/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(importers).toEqual([]);
  });

  it("ni le point d'entrée de l'agent ni les composants ne la réexportent", () => {
    for (const file of [
      "src/lib/information-agent.ts",
      "src/lib/admin-information-agent.ts",
      ...files(path.resolve(process.cwd(), "src/components")).filter(
        (entry) => /\.(?:ts|tsx)$/.test(entry) && !/\.test\./.test(entry),
      ),
    ]) {
      expect(readFileSync(path.resolve(process.cwd(), file), "utf8")).not.toMatch(
        /information-agent\/dry-run/,
      );
    }
  });
});
