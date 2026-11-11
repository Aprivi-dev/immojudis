import { describe, expect, it } from "vitest";
import {
  discoverInformationAgentContacts,
  resolveInformationAgentListingContacts,
  selectInformationAgentContact,
  type InformationAgentContactSale,
  type InformationAgentRegistryContact,
} from "@/lib/information-agent/contacts";
import {
  informationAgentListingBlockRole,
  isNonInterlocutorMention,
  readInformationAgentListingContactBlock,
  readInformationAgentOrganizerType,
  type InformationAgentListingContactBlock,
  type InformationAgentOrganizerType,
} from "@/lib/information-agent/listing-contacts";
import {
  INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS,
  INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE,
  allowedInformationAgentQuestionKeys,
  informationAgentQuestionAudience,
  informationAgentQuestionTextFor,
} from "@/lib/information-agent/recipient-questions";
import { informationAgentRecipientProfile } from "@/lib/information-agent/recipient-profile";
import { contactCandidateSnapshot } from "@/lib/information-agent/contacts";
import { INFORMATION_AGENT_QUESTIONS } from "@/lib/information-agent-questions";

// Jeux d'essai par source. Toutes les adresses sont fictives (`example.test`, `gmail.test`, sous-domaine
// inexistant de `justice.fr`).
const SALE_ID = "11111111-1111-4111-8111-111111111111";

type Fixture = {
  source: string;
  url: string;
  organizerType: InformationAgentOrganizerType;
  features?: unknown;
  observations?: Array<{ source: string; url: string; features: unknown }>;
  sale?: Record<string, unknown>;
  registry?: InformationAgentRegistryContact[];
};

function sale(fixture: Fixture): InformationAgentContactSale {
  const blocks = [
    readInformationAgentListingContactBlock(fixture.features, fixture.source, fixture.url),
    ...(fixture.observations ?? []).map((observation) =>
      readInformationAgentListingContactBlock(
        observation.features,
        observation.source,
        observation.url,
      ),
    ),
  ].filter((block): block is InformationAgentListingContactBlock => Boolean(block));
  return {
    id: SALE_ID,
    source_name: fixture.source,
    source_url: fixture.url,
    lawyer_name: null,
    lawyer_contact: null,
    description: null,
    source_description: null,
    source_blocks: null,
    source_blocks_by_source: null,
    listing_contact_blocks: blocks,
    information_agent_organizer_type: fixture.organizerType,
    registry_contacts: fixture.registry ?? [],
    ...fixture.sale,
  } as unknown as InformationAgentContactSale;
}

const NOTAIRES: Fixture = {
  source: "notaires",
  url: "https://annonces.example.test/notaires/vente-1",
  organizerType: "notary",
  features: {
    contact: { name: "Jean Martin", phone: "05 00 00 00 01", email: "jean.martin@example.test" },
    listing: { office_crpcen: "33001" },
  },
  // Le pipeline projette le contact de l'annonce dans `lawyer_contact`.
  sale: { lawyer_contact: "05 00 00 00 01 | jean.martin@example.test" },
};

const CESSIONS: Fixture = {
  source: "cessions_etat",
  url: "https://annonces.example.test/cessions/bien-2",
  organizerType: "state_service",
  features: {
    manager: {
      managers: [
        { name: "Claire Durand", email: "claire.durand@example.test", phone: "05 00 00 00 02" },
        { name: "Paul Petit", email: "paul.petit@example.test" },
        { name: "Pôle de gestion domaniale", email: "pgp.domaine@example.test" },
      ],
      direction_email: "pgp.domaine@example.test",
      manager_name: "Claire Durand",
      email: "pgp.domaine@example.test",
      phone: "05 00 00 00 02",
    },
  },
  sale: {
    lawyer_contact: "pgp.domaine@example.test",
    source_blocks: { gestionnaire_email: "pgp.domaine@example.test" },
  },
};

const ENCHERES_IMMOBILIERES: Fixture = {
  source: "encheres_immobilieres",
  url: "https://annonces.example.test/encheres-immobilieres/lot-3",
  organizerType: "pursuing_lawyer",
  features: {
    lawyer: {
      name: "Maître Anne Leroy",
      phone: "05 00 00 00 03",
      address: "1 rue du Palais, 33000 Bordeaux",
      email: "anne.leroy@example.test",
      website: "https://cabinet.example.test",
    },
  },
  sale: {
    lawyer_name: "Maître Anne Leroy",
    lawyer_contact: "05 00 00 00 03 | anne.leroy@example.test",
    source_blocks: { avocat_poursuivant_email: "anne.leroy@example.test" },
  },
};

const AVOVENTES: Fixture = {
  source: "avoventes",
  url: "https://annonces.example.test/avoventes/lot-4",
  organizerType: "pursuing_lawyer",
  features: { lawyer: { name: "SELARL Durand Avocats", email: "contact@example.test" } },
  sale: { lawyer_name: "SELARL Durand Avocats" },
};

const LICITOR: Fixture = {
  source: "licitor",
  url: "https://annonces.example.test/licitor/annonce-5",
  organizerType: "pursuing_lawyer",
  sale: {
    lawyer_name: "Maître Jeanne Exemple",
    lawyer_contact: "1, rue du Palais - 75001 Paris | Tél.: 01 00 00 00 01",
  },
  registry: [
    {
      email: "jeanne.exemple@example.test",
      displayName: "Maître Jeanne Exemple, Avocat",
      role: "lawyer",
      sourceName: "licitor",
      sourceUrl: "https://annonces.example.test/licitor/annonce-5",
      observedAt: "2026-11-10T10:00:00.000Z",
    },
  ],
};

describe("destinataire lu dans l'annonce, par source", () => {
  it("notaires : le contact de l'office, rôle notaire, adresse publiée dans l'annonce", () => {
    const candidates = discoverInformationAgentContacts(sale(NOTAIRES));
    const selected = selectInformationAgentContact(candidates);
    expect(candidates).toHaveLength(1);
    expect(selected).toMatchObject({
      email: "jean.martin@example.test",
      name: "Jean Martin",
      role: "notary",
      recipientKind: "source_contact",
      structureKind: "notary_office",
      addressKind: "nominative",
      officeCode: "33001",
      confidence: "high",
    });
    expect(selected?.provenance[0]).toEqual({
      kind: "source_block",
      field: "source_property_features.contact.email",
      sourceName: "notaires",
      sourceUrl: NOTAIRES.url,
    });
  });

  it("cessions_etat : la boîte du service, rôle service de l'État", () => {
    const resolution = resolveInformationAgentListingContacts(sale(CESSIONS));
    const selected = selectInformationAgentContact(resolution.candidates);
    expect(selected).toMatchObject({
      email: "pgp.domaine@example.test",
      role: "organizer",
      recipientKind: "source_contact",
      structureKind: "state_service",
      addressKind: "generic",
    });
    expect(selected?.provenance[0]).toMatchObject({
      sourceName: "cessions_etat",
      sourceUrl: CESSIONS.url,
    });
    // La gestionnaire nommée par l'annonce reste proposée ; l'autre personne n'est jamais retenue.
    expect(resolution.candidates.map((candidate) => candidate.email).sort()).toEqual([
      "claire.durand@example.test",
      "pgp.domaine@example.test",
    ]);
    expect(resolution.refused).toEqual({ nominative_other_person: 1 });
  });

  it("encheres_immobilieres : l'avocat poursuivant, inchangé", () => {
    const selected = selectInformationAgentContact(
      discoverInformationAgentContacts(sale(ENCHERES_IMMOBILIERES)),
    );
    expect(selected).toMatchObject({
      email: "anne.leroy@example.test",
      name: "Maître Anne Leroy",
      role: "lawyer",
      recipientKind: "source_lawyer",
      structureKind: "law_firm",
      addressKind: "nominative",
    });
    expect(selected?.officeCode).toBeUndefined();
  });

  it("avoventes : l'adresse générique du cabinet, rôle avocat", () => {
    const selected = selectInformationAgentContact(
      discoverInformationAgentContacts(sale(AVOVENTES)),
    );
    expect(selected).toMatchObject({
      email: "contact@example.test",
      role: "lawyer",
      recipientKind: "source_lawyer",
      addressKind: "generic",
    });
    expect(selected?.provenance[0]).toMatchObject({
      field: "source_property_features.lawyer.email",
      sourceUrl: AVOVENTES.url,
    });
  });

  it("licitor : l'adresse relevée par le pipeline (registre interne), rôle avocat", () => {
    const selected = selectInformationAgentContact(discoverInformationAgentContacts(sale(LICITOR)));
    expect(selected).toMatchObject({
      email: "jeanne.exemple@example.test",
      role: "lawyer",
      recipientKind: "source_lawyer",
      addressKind: "nominative",
    });
    expect(selected?.source).toMatchObject({ kind: "sale_listing", url: LICITOR.url });
  });
});

describe("adresse générique avant adresse nominative", () => {
  it("même structure (même domaine propre) : la générique est choisie seule", () => {
    const candidates = discoverInformationAgentContacts(
      sale({
        ...NOTAIRES,
        sale: {
          ...NOTAIRES.sale,
          source_blocks: { contact_office: "Office notarial : etude@example.test" },
        },
      }),
    );
    const [first, second] = candidates;
    expect(first).toMatchObject({
      email: "etude@example.test",
      addressKind: "generic",
      role: "notary",
    });
    expect(second).toMatchObject({ email: "jean.martin@example.test", addressKind: "nominative" });
    expect(first.score - second.score).toBeGreaterThanOrEqual(12);
    expect(selectInformationAgentContact(candidates)?.email).toBe("etude@example.test");
    // Le nom de la personne reste attaché à son adresse, pas à l'adresse générique.
    expect(first.name).not.toBe("Jean Martin");
  });

  it("deux adresses du même avocat dans le champ de la vente : la générique passe devant", () => {
    const candidates = discoverInformationAgentContacts(
      sale({
        ...ENCHERES_IMMOBILIERES,
        features: undefined,
        sale: {
          lawyer_name: "Maître Anne Leroy",
          lawyer_contact: "anne.leroy@example.test / cabinet@example.test",
        },
      }),
    );
    expect(selectInformationAgentContact(candidates)).toMatchObject({
      email: "cabinet@example.test",
      role: "lawyer",
      addressKind: "generic",
    });
  });

  it("sans adresse générique : l'adresse nominative de la personne nommée par l'annonce", () => {
    expect(
      selectInformationAgentContact(discoverInformationAgentContacts(sale(NOTAIRES))),
    ).toMatchObject({ email: "jean.martin@example.test", addressKind: "nominative" });
  });

  it("jamais l'adresse nominative d'une autre personne, même répétée ailleurs dans l'annonce", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...CESSIONS,
        sale: {
          ...CESSIONS.sale,
          description: "Renseignements : paul.petit@example.test",
          source_blocks: {
            gestionnaire_email: "pgp.domaine@example.test",
            autre_contact: "paul.petit@example.test",
          },
        },
        registry: [
          {
            email: "paul.petit@example.test",
            displayName: "Paul Petit",
            role: "organizer",
            sourceName: "cessions_etat",
            sourceUrl: CESSIONS.url,
            observedAt: "2026-11-10T10:00:00.000Z",
          },
        ],
      }),
    );
    expect(resolution.candidates.map((candidate) => candidate.email)).not.toContain(
      "paul.petit@example.test",
    );
    expect(resolution.refused.nominative_other_person).toBe(1);
  });

  it("deux structures différentes ne se départagent pas par cette règle", () => {
    // Messagerie grand public : aucun domaine propre, donc aucune structure commune.
    const candidates = discoverInformationAgentContacts(
      sale({
        ...ENCHERES_IMMOBILIERES,
        features: undefined,
        sale: {
          lawyer_name: "Maître Anne Leroy",
          lawyer_contact: "anne.leroy@gmail.test / cabinet@gmail.test",
        },
      }),
    );
    expect(candidates).toHaveLength(2);
    expect(selectInformationAgentContact(candidates)).toBeNull();
  });
});

describe("rôle refusé : cité autrement que comme interlocuteur de la vente", () => {
  it("un avocat publié dans une vente notariale n'est pas retenu", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...NOTAIRES,
        features: {
          contact: { name: "Jean Martin", email: "jean.martin@example.test" },
          lawyer: { name: "Maître Anne Leroy", email: "anne.leroy@example.test" },
        },
        sale: {
          lawyer_contact: "jean.martin@example.test",
          source_blocks: { avocat: "Maître Leroy, avocat, a.leroy@example.test" },
        },
      }),
    );
    expect(resolution.candidates.map((candidate) => candidate.email)).toEqual([
      "jean.martin@example.test",
    ]);
    expect(resolution.refused).toEqual({ role_not_sale_interlocutor: 2 });
  });

  it("un notaire cité dans une vente au tribunal n'est pas retenu", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...ENCHERES_IMMOBILIERES,
        sale: {
          ...ENCHERES_IMMOBILIERES.sale,
          source_blocks: { notaire: "Me Paul Petit, notaire : paul.petit@example.test" },
        },
      }),
    );
    expect(resolution.candidates.map((candidate) => candidate.email)).toEqual([
      "anne.leroy@example.test",
    ]);
    expect(resolution.refused).toEqual({ role_not_sale_interlocutor: 1 });
  });

  it("un service gestionnaire publié hors d'une cession de l'État n'est pas retenu", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({ ...CESSIONS, organizerType: "pursuing_lawyer", sale: {} }),
    );
    expect(resolution.candidates).toEqual([]);
    expect(resolution.refused.role_not_sale_interlocutor).toBe(3);
  });

  it.each([
    ["Syndic de l'immeuble : cabinet.syndic@example.test"],
    ["Avocat de la partie saisie : maitre.durand@example.test"],
    ["Conseil du débiteur : Me Durand, maitre.durand@example.test"],
    ["Liquidateur : etude.mj@example.test"],
    ["Mandataire judiciaire, etude.mj@example.test"],
    ["Avocat des créanciers inscrits : maitre.durand@example.test"],
  ])("« %s » n'est pas l'interlocuteur de la vente", (text) => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...ENCHERES_IMMOBILIERES,
        sale: { ...ENCHERES_IMMOBILIERES.sale, description: text },
      }),
    );
    expect(resolution.candidates.map((candidate) => candidate.email)).toEqual([
      "anne.leroy@example.test",
    ]);
    expect(resolution.refused).toEqual({ not_sale_interlocutor: 1 });
  });

  it("la mention d'un autre titre ne vaut que pour l'adresse qui la suit", () => {
    const text =
      "Syndic : cabinet.syndic@example.test. Renseignements auprès de l'avocat poursuivant : a.leroy@example.test";
    expect(isNonInterlocutorMention("description", text, "cabinet.syndic@example.test")).toBe(true);
    expect(isNonInterlocutorMention("description", text, "a.leroy@example.test")).toBe(false);
    expect(
      isNonInterlocutorMention("source_blocks.syndic", "x@example.test", "x@example.test"),
    ).toBe(true);
  });

  it("« étude » seule ne fait pas un notaire", () => {
    const [candidate] = discoverInformationAgentContacts(
      sale({
        ...ENCHERES_IMMOBILIERES,
        features: undefined,
        sale: {
          source_blocks: { contact: "Étude Durand, commissaire de justice : etude@example.test" },
        },
      }),
    );
    expect(candidate.role).toBe("organizer");
  });
});

describe("table des rôles par organisateur", () => {
  const role = (
    block: "contact" | "manager" | "lawyer",
    organizerType: InformationAgentOrganizerType,
    sourceName: string | null = null,
    lawyerAddress = false,
  ) => informationAgentListingBlockRole({ block, organizerType, sourceName, lawyerAddress })?.role;

  it("vente notariale : le contact est le notaire, rien d'autre", () => {
    expect(role("contact", "notary")).toBe("notary");
    expect(role("lawyer", "notary")).toBeUndefined();
    expect(role("manager", "notary")).toBeUndefined();
  });
  it("cession de l'État : le gestionnaire, rien d'autre", () => {
    expect(
      informationAgentListingBlockRole({
        block: "manager",
        organizerType: "state_service",
        sourceName: "cessions_etat",
        lawyerAddress: false,
      }),
    ).toEqual({ role: "organizer", structureKind: "state_service" });
    expect(role("contact", "state_service")).toBeUndefined();
    expect(role("lawyer", "state_service")).toBeUndefined();
  });
  it("avocat poursuivant : le bloc avocat ; le bloc contact seulement si c'est son adresse", () => {
    expect(role("lawyer", "pursuing_lawyer")).toBe("lawyer");
    expect(role("contact", "pursuing_lawyer", null, true)).toBe("lawyer");
    expect(role("contact", "pursuing_lawyer", null, false)).toBe("source_contact");
    expect(role("manager", "pursuing_lawyer")).toBeUndefined();
  });
  it("organisateur inconnu : la source de l'annonce départage", () => {
    expect(role("lawyer", "unknown")).toBe("lawyer");
    expect(role("contact", "unknown", "notaires")).toBe("notary");
    expect(role("contact", "unknown", "avoventes")).toBe("source_contact");
    expect(role("manager", "unknown", "cessions_etat")).toBe("organizer");
    expect(role("manager", "unknown", "licitor")).toBeUndefined();
  });
  it("lit `organizer_type`, la colonne d'abord ; toute autre valeur vaut inconnu", () => {
    expect(readInformationAgentOrganizerType({ organizer_type: "notary" })).toBe("notary");
    expect(readInformationAgentOrganizerType({}, { organizer_type: "state_service" })).toBe(
      "state_service",
    );
    expect(readInformationAgentOrganizerType({ organizer_type: "seller" }, null)).toBe("unknown");
    expect(readInformationAgentOrganizerType(null)).toBe("unknown");
  });
});

describe("lecture des blocs de contact de l'annonce", () => {
  it("ancienne forme du gestionnaire (`contacts`) : la première personne est le contact de la vente", () => {
    const block = readInformationAgentListingContactBlock(
      {
        manager: {
          manager_name: "Direction des finances publiques",
          email: "claire.durand@example.test",
          contacts: [
            { nom: "Durand", prenom: "Claire", email: "claire.durand@example.test" },
            { nom: "Petit", prenom: "Paul", email: "paul.petit@example.test" },
          ],
        },
      },
      "cessions_etat",
      CESSIONS.url,
    );
    expect(block?.manager).toEqual([
      {
        email: "claire.durand@example.test",
        name: "Claire Durand",
        field: "source_property_features.manager.contacts[0].email",
        principal: true,
      },
      {
        email: "paul.petit@example.test",
        name: "Paul Petit",
        field: "source_property_features.manager.contacts[1].email",
        principal: false,
      },
    ]);
  });

  it("aucune adresse : aucun bloc ; une valeur qui n'est pas une adresse est ignorée", () => {
    expect(
      readInformationAgentListingContactBlock(
        { contact: { name: "Jean Martin", phone: "05 00 00 00 01", email: "non communiqué" } },
        "notaires",
        null,
      ),
    ).toBeNull();
    expect(readInformationAgentListingContactBlock(null, "notaires", null)).toBeNull();
  });
});

describe("adresses écartées, tous rôles", () => {
  it("`justice.fr` n'est jamais un destinataire lu dans l'annonce", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...CESSIONS,
        features: {
          manager: { manager_name: "Greffe", email: "greffe@exemple-fictif.justice.fr" },
        },
        sale: {},
      }),
    );
    expect(resolution.candidates).toEqual([]);
    expect(resolution.refused).toEqual({ excluded_address: 1 });
  });

  it("adresses techniques, RPVA, Ordre : écartées pour un notaire comme pour un avocat", () => {
    for (const email of [
      "noreply@example.test",
      "dpo@example.test",
      "maitre.durand@exemple-fictif.avocat-conseil.fr",
      "ordre@example.test",
    ]) {
      const resolution = resolveInformationAgentListingContacts(
        sale({ ...NOTAIRES, features: { contact: { name: "Jean Martin", email } }, sale: {} }),
      );
      expect(resolution.candidates).toEqual([]);
      expect(resolution.refused).toEqual({ excluded_address: 1 });
    }
  });

  it("une messagerie grand public publiée dans l'annonce reste admise", () => {
    const selected = selectInformationAgentContact(
      discoverInformationAgentContacts(
        sale({
          ...NOTAIRES,
          features: { contact: { name: "Jean Martin", email: "jean.martin@gmail.test" } },
          sale: {},
        }),
      ),
    );
    expect(selected).toMatchObject({ email: "jean.martin@gmail.test", role: "notary" });
  });
});

describe("ce qu'on peut demander selon le rôle", () => {
  it("notaire et service de l'État : les champs de la fiche et le lieu de consultation, liste fermée", () => {
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
  });

  it("avocat poursuivant : inchangé, toutes les questions", () => {
    expect([...INFORMATION_AGENT_QUESTION_KEYS_BY_AUDIENCE.lawyer].sort()).toEqual(
      Object.keys(INFORMATION_AGENT_QUESTIONS).sort(),
    );
    expect(informationAgentQuestionTextFor("lawyer", "documents")).toBe(
      INFORMATION_AGENT_QUESTIONS.documents.question,
    );
  });

  it("rôle du destinataire", () => {
    expect(informationAgentQuestionAudience({ role: "lawyer" })).toBe("lawyer");
    expect(informationAgentQuestionAudience({ role: "notary" })).toBe("notary");
    expect(
      informationAgentQuestionAudience({ role: "organizer", structureKind: "state_service" }),
    ).toBe("state_service");
    expect(informationAgentQuestionAudience({ role: "organizer" })).toBe("other");
    expect(informationAgentQuestionAudience({ role: null })).toBe("other");
  });

  it("rien sur la procédure, le prix, le vendeur ni les pièces du dossier", () => {
    expect(
      allowedInformationAgentQuestionKeys("notary", [
        "sale_date",
        "starting_price_eur",
        "sale_terms",
        "diagnostics",
        "cadastre",
        "photos",
        "surface",
        "visit",
      ]),
    ).toEqual(["surface", "visit"]);
    expect(() => informationAgentQuestionTextFor("state_service", "sale_terms")).toThrow(
      "non admise",
    );
    const asked = INFORMATION_AGENT_LISTING_FIELD_QUESTION_KEYS.map((key) =>
      informationAgentQuestionTextFor("notary", key),
    ).join("\n");
    expect(asked).toContain("cahier des charges");
    expect(asked).not.toMatch(
      /vendeur|d[ée]biteur|propri[ée]taire|origine|proc[ée]dure|loyer|transmettre|mise à prix/i,
    );
  });
});

describe("ce que l'administrateur voit du destinataire", () => {
  const profile = (fixture: Fixture) => {
    const candidates = discoverInformationAgentContacts(sale(fixture));
    const selected = selectInformationAgentContact(candidates);
    return informationAgentRecipientProfile(
      { contact_discovery: { candidates: candidates.map(contactCandidateSnapshot) } },
      selected?.email ?? "",
    );
  };

  it("rôle, origine et nature de l'adresse, par source", () => {
    expect(profile(NOTAIRES)).toEqual({
      roleLabel: "Notaire",
      addressKind: "nominative",
      addressKindLabel: "Adresse nominative",
      originLabel: "Adresse publiée dans l’annonce",
      originSourceName: "notaires",
      originUrl: NOTAIRES.url,
    });
    expect(profile(CESSIONS)).toMatchObject({
      roleLabel: "Service de l’État",
      addressKind: "generic",
      addressKindLabel: "Adresse générique de la structure",
      originUrl: CESSIONS.url,
    });
    expect(profile(AVOVENTES)).toMatchObject({ roleLabel: "Avocat", addressKind: "generic" });
    expect(profile(LICITOR)).toMatchObject({
      roleLabel: "Avocat",
      addressKind: "nominative",
      originLabel: "Adresse publiée dans l’annonce",
    });
  });

  it("une adresse saisie par l'administrateur n'a pas de profil", () => {
    const candidates = discoverInformationAgentContacts(sale(NOTAIRES));
    expect(
      informationAgentRecipientProfile(
        { contact_discovery: { candidates: candidates.map(contactCandidateSnapshot) } },
        "autre.adresse@example.test",
      ),
    ).toBeNull();
    expect(informationAgentRecipientProfile({}, "jean.martin@example.test")).toBeNull();
  });
});
