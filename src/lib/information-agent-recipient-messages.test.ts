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
import { isPublicErrorMessage } from "@/lib/api-error-detail";
import { classifyApiError } from "@/lib/api-observability";
import { INFORMATION_AGENT_QUESTIONS } from "@/lib/information-agent-questions";
import {
  INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE,
  INFORMATION_AGENT_STRUCTURE_OPPOSED_MESSAGE,
  INFORMATION_AGENT_STRUCTURE_UNKNOWN_MESSAGE,
} from "@/lib/information-agent/contacts";
import {
  INFORMATION_AGENT_NO_GAP_FOR_LISTING_FIELDS_MESSAGE,
  INFORMATION_AGENT_NO_GAP_MESSAGE,
} from "@/lib/information-agent/draft";
import {
  assertInformationAgentNotarySendAllowed,
  INFORMATION_AGENT_NOTARY_SEND_DISABLED_MESSAGE,
} from "@/lib/information-agent/config";
import {
  assertInformationAgentQuestionsAllowed,
  INFORMATION_AGENT_AUDIENCE_UNKNOWN_MESSAGE,
  INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE,
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

describe("destinataire des questions : le rôle établi, sinon l'organisateur de la vente, sinon la source", () => {
  const audience = (
    role: string | null,
    organizerType: "pursuing_lawyer" | "notary" | "state_service" | "unknown",
    sourceName: string | null = "licitor",
    structureKind?: "state_service",
  ) => informationAgentQuestionAudience({ role, organizerType, sourceName, structureKind });

  it("rôle établi", () => {
    expect(audience("lawyer", "pursuing_lawyer")).toBe("lawyer");
    expect(audience("notary", "notary", "notaires")).toBe("notary");
    expect(audience("organizer", "state_service", "cessions_etat", "state_service")).toBe(
      "state_service",
    );
  });

  it.each([null, "source_contact", "organizer", "manual_professional"])(
    "rôle non établi (%s) : liste courte sur une vente notariale ou une cession, inchangé ailleurs",
    (role) => {
      expect(audience(role, "notary")).toBe("notary");
      expect(audience(role, "state_service")).toBe("state_service");
      expect(audience(role, "pursuing_lawyer")).toBe("other");
      expect(audience(role, "unknown")).toBe("other");
    },
  );

  it.each([null, "source_contact", "manual_professional"])(
    "organisateur inconnu, rôle non établi (%s) : la source de l'annonce départage",
    (role) => {
      // Adresse saisie par l'administrateur sur une vente d'une source `notaires` : liste courte, envoi fermé.
      expect(audience(role, "unknown", "notaires")).toBe("notary");
      expect(audience(role, "unknown", "cessions_etat")).toBe("state_service");
      expect(audience(role, "unknown", "avoventes")).toBe("other");
      expect(audience(role, "unknown", null)).toBe("other");
      // Même départage quand l'organisateur déclaré contredit la source.
      expect(audience(role, "pursuing_lawyer", "notaires")).toBe("notary");
    },
  );

  it("un notaire désigné reste un notaire même si l'organisateur de la vente est inconnu", () => {
    expect(audience("notary", "unknown", null)).toBe("notary");
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
      expect(() => informationAgentQuestionTextFor("state_service", key)).toThrow("not allowed");
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
      expect(() => assertInformationAgentQuestionsAllowed(unknown, [])).toThrow("non identifié");
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
  const notary = { role: "notary", questionAudience: "notary", email: "jean.martin@example.test" };

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
    const email = "jean.martin@example.test";
    expect(() =>
      assertInformationAgentNotarySendAllowed(
        { role: null, questionAudience: "notary", email },
        {},
      ),
    ).toThrow("Envoi à un notaire fermé");
    expect(() =>
      assertInformationAgentNotarySendAllowed(
        { role: "notary", questionAudience: "other", email },
        {},
      ),
    ).toThrow("Envoi à un notaire fermé");
    for (const recipient of [
      { role: "lawyer", questionAudience: "lawyer", email },
      { role: "organizer", questionAudience: "state_service", email },
      { role: null, questionAudience: "other", email },
    ]) {
      expect(() => assertInformationAgentNotarySendAllowed(recipient, {})).not.toThrow();
    }
  });

  it("vaut pour toute adresse en `notaires.fr` ou l'un de ses sous-domaines, quel que soit le rôle", () => {
    const lawyer = { role: "lawyer", questionAudience: "lawyer" };
    for (const email of [
      "jean.martin@exemple-fictif.notaires.fr",
      "ETUDE@Paris.Exemple-Fictif.Notaires.fr",
    ]) {
      expect(() => assertInformationAgentNotarySendAllowed({ ...lawyer, email }, {})).toThrow(
        "Envoi à un notaire fermé",
      );
      expect(() =>
        assertInformationAgentNotarySendAllowed(
          { ...lawyer, email },
          { INFORMATION_AGENT_NOTARY_SEND_ENABLED: "true" },
        ),
      ).not.toThrow();
    }
    // Un domaine qui contient le mot sans être le domaine du notariat n'est pas concerné.
    for (const email of ["contact@mesnotaires.example.test", "contact@notaires.fr.example.test"]) {
      expect(() => assertInformationAgentNotarySendAllowed({ ...lawyer, email }, {})).not.toThrow();
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
  const listing = {
    sourceKind: "sale_listing" as const,
    sourceName: "licitor",
    sourceUrl: "https://annonces.example.test/licitor/1",
    observedAt: "2026-11-10T08:00:00Z",
    observedBy: "agent" as const,
  };
  const WORDS = [
    ["law_firm", "de votre cabinet", "de ce cabinet"],
    ["notary_office", "de votre étude", "de cette étude"],
    ["state_service", "de votre service", "de ce service"],
  ] as const;

  it.each(WORDS)(
    "%s : le mot de la structure dans l'origine, les catégories et la portée",
    (kind, yours, that) => {
      const origin = informationAgentAddressOrigin({ ...listing, structureAddress: kind });
      expect(origin.text).toBe(
        `L’adresse de contact ${yours} figure dans l’annonce publique de cette vente sur Licitor (https://annonces.example.test/licitor/1), consultée le 10/11/2026.`,
      );
      expect(origin.structureAddress).toBe(kind);
      const lines = informationAgentLegalFooterLines(
        footer({ addressOrigin: origin.text, structureAddress: kind, structureOpposition: kind }),
      ).join("\n");
      expect(lines).toContain(
        `Vos données : l’adresse de contact ${yours} et, si vous répondez, le nom, la fonction et les coordonnées de la personne qui répond, ainsi que nos échanges. Origine : L’adresse de contact ${yours} figure`,
      );
      expect(lines).toContain(
        `Opposition : ${INFORMATION_AGENT_OBJECTION_STATEMENT} Si vous vous opposez depuis l’adresse de contact ${yours}, nous n’écrirons plus à aucune adresse ${that}.`,
      );
      // Un cabinet d'avocat n'est jamais appelé « étude » ou « service », et inversement.
      for (const [other, otherYours] of WORDS) {
        if (other !== kind) expect(lines).not.toContain(otherYours);
      }
    },
  );

  it("structure inconnue : formule générale", () => {
    const origin = informationAgentAddressOrigin({ ...listing, structureAddress: "unknown" });
    expect(origin.text).toContain(
      "L’adresse de contact de votre étude, de votre cabinet ou de votre service figure dans l’annonce",
    );
    expect(
      informationAgentLegalFooterLines(footer({ structureOpposition: "unknown" })).join("\n"),
    ).toContain(
      "Si vous vous opposez depuis l’adresse de contact d’une étude, d’un cabinet ou d’un service, nous n’écrirons plus à aucune adresse de cette structure.",
    );
    expect(INFORMATION_AGENT_STRUCTURE_OBJECTION_SCOPE_STATEMENT).toBe(
      "Si vous vous opposez depuis l’adresse de contact d’une étude, d’un cabinet ou d’un service, nous n’écrirons plus à aucune adresse de cette structure.",
    );
  });

  it("sans variante : pied de la personne ; un greffe garde la sienne", () => {
    const person = informationAgentAddressOrigin(listing);
    expect(person.text).toContain("Votre adresse professionnelle figure dans l’annonce publique");
    expect(person.structureAddress).toBeUndefined();
    const lines = informationAgentLegalFooterLines(footer({})).join("\n");
    expect(lines).toContain(
      "Vos données : votre nom, votre fonction, votre adresse professionnelle",
    );
    expect(lines).not.toContain("nous n’écrirons plus à aucune adresse");
    const court = informationAgentAddressOrigin({
      sourceKind: "court_registry_fallback",
      structureAddress: "law_firm",
    });
    expect(court.courtRegistry).toBe(true);
    expect(court.structureAddress).toBeUndefined();
  });

  it("personne nommée à une adresse générique : catégories ordinaires et portée de l'opposition, sans contradiction", () => {
    const lines = informationAgentLegalFooterLines(
      footer({
        addressOrigin: informationAgentAddressOrigin(listing).text,
        structureAddress: null,
        structureOpposition: "law_firm",
      }),
    ).join("\n");
    expect(lines).toContain(
      "Vos données : votre nom, votre fonction, votre adresse professionnelle et nos échanges. Origine : Votre adresse professionnelle figure",
    );
    expect(lines).not.toContain("si vous répondez, le nom, la fonction");
    expect(lines).toContain("nous n’écrirons plus à aucune adresse de ce cabinet.");
  });
});

describe("les messages de refus de l'agent arrivent tels quels à l'administrateur", () => {
  it.each([
    ["destinataire du brouillon non identifié", INFORMATION_AGENT_AUDIENCE_UNKNOWN_MESSAGE],
    ["envois aux notaires fermés", INFORMATION_AGENT_NOTARY_SEND_DISABLED_MESSAGE],
    ["structure opposée", INFORMATION_AGENT_STRUCTURE_OPPOSED_MESSAGE],
    ["structure non identifiable", INFORMATION_AGENT_STRUCTURE_UNKNOWN_MESSAGE],
    ["professionnel opposé", INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE],
    ["question hors liste", INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE],
    ["aucune lacune", INFORMATION_AGENT_NO_GAP_MESSAGE],
    ["aucune lacune de la liste courte", INFORMATION_AGENT_NO_GAP_FOR_LISTING_FIELDS_MESSAGE],
  ])("%s : ni marqueur technique ni longueur excessive", async (_label, message) => {
    // L'enveloppe des routes admin remplace par son message générique tout message que ce filtre refuse.
    expect(isPublicErrorMessage(message)).toBe(true);
    expect(
      classifyApiError(new Error(message), {
        fallbackMessage: "Action impossible.",
        exposeBusinessMessages: true,
      }),
    ).toMatchObject({ status: 400, message });
  });

  it("le message de régénération nomme le bouton de l'écran", () => {
    expect(INFORMATION_AGENT_AUDIENCE_UNKNOWN_MESSAGE).toBe(
      "Destinataire du brouillon non identifié : régénérez le brouillon avec le bouton “Régénérer le brouillon”.",
    );
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
