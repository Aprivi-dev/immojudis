import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAutopilotCandidate } from "@/lib/information-agent/autopilot-rules";
import {
  contactCandidateSnapshot,
  discoverInformationAgentContacts,
  resolveInformationAgentListingContacts,
  selectInformationAgentContact,
  type InformationAgentContactSale,
  type InformationAgentRegistryContact,
} from "@/lib/information-agent/contact-resolution";
import {
  INFORMATION_AGENT_STATE_FUNCTIONAL_MAILBOX_WORDS,
  informationAgentListingBlockRole,
  informationAgentSaleFieldRole,
  isNonInterlocutorMention,
  readInformationAgentListingContactBlock,
  readInformationAgentOrganizerType,
  type InformationAgentListingContactBlock,
  type InformationAgentOrganizerType,
} from "@/lib/information-agent/listing-contacts";
import { informationAgentRecipientProfile } from "@/lib/information-agent/recipient-profile";

// Jeux d'essai par source. Toutes les adresses sont fictives (`example.test`, `gmail.test`, sous-domaines
// inexistants de `justice.fr`, `notaires.fr` et `avocat-conseil.fr`).
const SALE_ID = "11111111-1111-4111-8111-111111111111";

type Fixture = {
  source: string;
  url: string;
  /** Absent : la vente ne porte que `sale_procedure` (donné dans `sale`), comme en base. */
  organizerType?: InformationAgentOrganizerType;
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
    ...(fixture.organizerType ? { information_agent_organizer_type: fixture.organizerType } : {}),
    registry_contacts: fixture.registry ?? [],
    ...fixture.sale,
  } as unknown as InformationAgentContactSale;
}

const emails = (fixture: Fixture) =>
  resolveInformationAgentListingContacts(sale(fixture)).candidates.map(
    (candidate) => candidate.email,
  );

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
      field: "source_property_features.manager.direction_email",
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

describe("rôle du contact porté par `lawyer_contact` : jamais tiré du nom du champ", () => {
  const withField = (source: string, saleProcedure: unknown, features?: unknown): Fixture => ({
    source,
    url: `https://annonces.example.test/${source}/1`,
    features,
    sale: {
      lawyer_name: "Jean Martin",
      lawyer_contact: "jean.martin@example.test",
      sale_procedure: saleProcedure,
    },
  });
  const roleOf = (fixture: Fixture) => {
    const [candidate] = discoverInformationAgentContacts(sale(fixture));
    return candidate?.role;
  };
  /** Verdict du pilote pour ce rôle, tout le reste étant admis. */
  const pilotVerdict = (recipientRole: string) =>
    evaluateAutopilotCandidate(
      {
        sourceKind: "sale_listing",
        recipientRole,
        selectedUnambiguously: true,
        identityComplete: true,
        addressHygieneIssue: null,
        consumerDomain: false,
        observationChannel: null,
        addressObservedAt: "2026-11-01T10:00:00Z",
        mailDomain: "ok",
        saleDate: "2026-12-20T10:00:00Z",
        hasUnpublishedGap: true,
        humanDraftExists: false,
        identityExcluded: false,
        contactFirstRecordedAt: "2026-11-01T10:00:00Z",
        alreadyInformed: false,
        lastReplyAt: null,
        silentSendsInSixMonths: 0,
        lastSendAt: null,
      },
      { allowLicitorDecoded: false, art14MaxAgeDays: 30 },
      new Date("2026-11-03T09:30:00Z"),
    );

  it.each([
    ["organisateur `unknown`", { organizer_type: "unknown" }],
    ["`sale_procedure` nul", null],
    ["`sale_procedure` vide", {}],
    ["organisateur hors liste (`seller`)", { organizer_type: "seller" }],
  ])("source `notaires`, %s : notaire, et le pilote refuse", (_label, saleProcedure) => {
    const role = roleOf(withField("notaires", saleProcedure));
    expect(role).toBe("notary");
    expect(pilotVerdict(role ?? "")).toEqual({ ok: false, code: "role_not_lawyer" });
  });

  it.each([
    ["organisateur `unknown`", { organizer_type: "unknown" }],
    ["`sale_procedure` nul", null],
    ["organisateur hors liste (`seller`)", { organizer_type: "seller" }],
  ])("source `cessions_etat`, %s : service de l'État, et le pilote refuse", (_label, procedure) => {
    const [candidate] = discoverInformationAgentContacts(
      sale(withField("cessions_etat", procedure)),
    );
    expect(candidate).toMatchObject({ role: "organizer", structureKind: "state_service" });
    expect(pilotVerdict(candidate.role)).toEqual({ ok: false, code: "role_not_lawyer" });
  });

  it.each([
    ["organisateur `unknown`", { organizer_type: "unknown" }],
    ["`sale_procedure` nul", null],
    ["organisateur hors liste (`seller`)", { organizer_type: "seller" }],
  ])("autre source, %s, sans bloc avocat : contact de l'annonce, et le pilote refuse", (_l, p) => {
    const [candidate] = discoverInformationAgentContacts(sale(withField("licitor", p)));
    expect(candidate).toMatchObject({ role: "source_contact", recipientKind: "source_contact" });
    expect(candidate.structureKind).toBeUndefined();
    expect(pilotVerdict(candidate.role)).toEqual({ ok: false, code: "role_not_lawyer" });
  });

  it("organisateur inconnu : avocat seulement si un bloc `lawyer` porte la même adresse", () => {
    const corroborated = withField("licitor", null, {
      lawyer: { name: "Jean Martin", email: "jean.martin@example.test" },
    });
    expect(roleOf(corroborated)).toBe("lawyer");
    const otherLawyer = withField("licitor", null, {
      lawyer: { name: "Anne Leroy", email: "anne.leroy@example.test" },
    });
    const candidates = discoverInformationAgentContacts(sale(otherLawyer));
    expect(candidates.find((c) => c.email === "jean.martin@example.test")?.role).toBe(
      "source_contact",
    );
    expect(candidates.find((c) => c.email === "anne.leroy@example.test")?.role).toBe("lawyer");
  });

  it("organisateur `pursuing_lawyer` sur une source `notaires` ou `cessions_etat` : pas « avocat »", () => {
    for (const source of ["notaires", "cessions_etat"]) {
      const role = roleOf(withField(source, { organizer_type: "pursuing_lawyer" }));
      expect(role).toBe("source_contact");
      expect(pilotVerdict(role ?? "")).toEqual({ ok: false, code: "role_not_lawyer" });
    }
    // Vente au tribunal sur une source d'annonces judiciaires : l'avocat poursuivant, admis par le pilote.
    const role = roleOf(withField("licitor", { organizer_type: "pursuing_lawyer" }));
    expect(role).toBe("lawyer");
    expect(pilotVerdict(role ?? "")).toEqual({ ok: true });
  });

  it("vente notariale ou cession publiée par une autre source : contact de l'annonce", () => {
    expect(roleOf(withField("licitor", { organizer_type: "notary" }))).toBe("source_contact");
    expect(roleOf(withField("licitor", { organizer_type: "state_service" }))).toBe(
      "source_contact",
    );
    expect(roleOf(withField("notaires", { organizer_type: "notary" }))).toBe("notary");
  });

  it("table du champ, cas par cas", () => {
    const role = (
      organizerType: InformationAgentOrganizerType,
      sourceName: string | null,
      lawyerAddress = false,
    ) => informationAgentSaleFieldRole({ organizerType, sourceName, lawyerAddress }).role;
    expect(role("unknown", null)).toBe("source_contact");
    expect(role("unknown", null, true)).toBe("lawyer");
    // La source prime sur un bloc avocat : `notaires` ne publie que des notaires.
    expect(role("unknown", "notaires", true)).toBe("notary");
    expect(role("pursuing_lawyer", "avoventes")).toBe("lawyer");
  });
});

describe("adresse générique avant adresse nominative", () => {
  it("même bloc de contact : la générique passe devant, avec le rôle du bloc", () => {
    const candidates = discoverInformationAgentContacts(sale(CESSIONS));
    const [first, second] = candidates;
    expect(first).toMatchObject({
      email: "pgp.domaine@example.test",
      addressKind: "generic",
      role: "organizer",
      structureKind: "state_service",
    });
    expect(second).toMatchObject({
      email: "claire.durand@example.test",
      addressKind: "nominative",
      role: "organizer",
      name: "Claire Durand",
    });
    expect(first.score - second.score).toBeGreaterThanOrEqual(12);
    // Le nom de la personne reste attaché à son adresse, pas à l'adresse générique.
    expect(first.name).toBeNull();
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

  it("champ de la vente, deux cabinets différents : aucune préférence, l'administrateur tranche", () => {
    const candidates = discoverInformationAgentContacts(
      sale({
        ...ENCHERES_IMMOBILIERES,
        features: undefined,
        sale: {
          lawyer_name: "Maître Jean Dupont",
          lawyer_contact: "jean.dupont@cabinet-a.example.test / contact@cabinet-b.example.test",
        },
      }),
    );
    expect(candidates.map((candidate) => [candidate.email, candidate.addressKind])).toEqual([
      ["contact@cabinet-b.example.test", "generic"],
      ["jean.dupont@cabinet-a.example.test", "nominative"],
    ]);
    expect(candidates[0].score).toBe(candidates[1].score);
    expect(selectInformationAgentContact(candidates)).toBeNull();
  });

  it("champ de la vente, messagerie sans domaine propre : aucune préférence non plus", () => {
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

  it("sans adresse générique : l'adresse nominative de la personne nommée par l'annonce", () => {
    expect(
      selectInformationAgentContact(discoverInformationAgentContacts(sale(NOTAIRES))),
    ).toMatchObject({ email: "jean.martin@example.test", addressKind: "nominative" });
  });

  it("un simple domaine commun ne donne ni le rang ni le rôle à une adresse générique d'un texte libre", () => {
    const candidates = discoverInformationAgentContacts(
      sale({
        ...NOTAIRES,
        sale: {
          ...NOTAIRES.sale,
          description: "Renseignements : contact@example.test",
          source_blocks: { divers: "Écrire à accueil@example.test" },
        },
      }),
    );
    const byEmail = new Map(candidates.map((candidate) => [candidate.email, candidate]));
    // Le notaire désigné reste premier et choisi seul.
    expect(candidates[0].email).toBe("jean.martin@example.test");
    expect(selectInformationAgentContact(candidates)?.email).toBe("jean.martin@example.test");
    // Les adresses génériques du même domaine gardent leur confiance basse et leur rôle non établi.
    for (const email of ["contact@example.test", "accueil@example.test"]) {
      expect(byEmail.get(email)).toMatchObject({
        addressKind: "generic",
        role: "source_contact",
        recipientKind: "source_contact",
        confidence: "low",
      });
      expect(byEmail.get(email)?.structureKind).toBeUndefined();
      expect(byEmail.get(email)?.officeCode).toBeUndefined();
    }
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
});

describe("cessions de l'État : boîte du service et gestionnaire nommé", () => {
  const manager = (value: Record<string, unknown>) =>
    readInformationAgentListingContactBlock({ manager: value }, "cessions_etat", CESSIONS.url)
      ?.manager;

  it("`direction_email` est lue d'abord, principale, quelle que soit sa forme", () => {
    const records = manager({
      manager_name: "Claire Durand",
      direction_email: "sdnc.gestion-domaniale@example.test",
      email: "sdnc.gestion-domaniale@example.test",
      managers: [
        { name: "Claire Durand", email: "claire.durand@example.test" },
        { name: "Paul Petit", email: "paul.petit@example.test" },
      ],
    });
    expect(records?.[0]).toEqual({
      email: "sdnc.gestion-domaniale@example.test",
      name: null,
      field: "source_property_features.manager.direction_email",
      principal: true,
      // « gestion » : boîte fonctionnelle au sens du pipeline, bien que « sdnc » ne soit pas un mot générique.
      addressKind: "generic",
    });
    expect(records?.map((record) => [record.email, record.principal])).toEqual([
      ["sdnc.gestion-domaniale@example.test", true],
      ["claire.durand@example.test", true],
      ["paul.petit@example.test", false],
    ]);
  });

  it("sans boîte fonctionnelle publiée, le pipeline désigne une personne : l'adresse reste nominative", () => {
    const records = manager({
      manager_name: "Claire Durand",
      direction_email: "claire.durand@example.test",
      email: "claire.durand@example.test",
      managers: [
        { name: "Claire Durand", email: "claire.durand@example.test" },
        { name: "Paul Petit", email: "paul.petit@example.test" },
      ],
    });
    expect(records?.map((record) => [record.email, record.principal, record.addressKind])).toEqual([
      ["claire.durand@example.test", true, "nominative"],
      ["paul.petit@example.test", false, "nominative"],
    ]);
  });

  it("le gestionnaire nommé se reconnaît sous une autre forme de nom : pas de repli sur la première personne", () => {
    const records = manager({
      manager_name: "Marie Durand",
      managers: [
        { name: "Paul Petit", email: "paul.petit@example.test" },
        { name: "DURAND Marie", email: "marie.durand@example.test" },
      ],
    });
    expect(records?.map((record) => [record.email, record.principal])).toEqual([
      ["paul.petit@example.test", false],
      ["marie.durand@example.test", true],
    ]);
    // Et dans la résolution : Paul Petit n'est jamais retenu, Marie Durand l'est.
    expect(
      emails({
        ...CESSIONS,
        features: {
          manager: {
            manager_name: "Marie Durand",
            managers: [
              { name: "Paul Petit", email: "paul.petit@example.test" },
              { name: "DURAND Marie", email: "marie.durand@example.test" },
            ],
          },
        },
        sale: {},
      }),
    ).toEqual(["marie.durand@example.test"]);
  });

  it("ancienne forme (`contacts`), l'annonce nomme un service : la première personne est le contact de la vente", () => {
    expect(
      manager({
        manager_name: "Direction des finances publiques",
        email: "claire.durand@example.test",
        contacts: [
          { nom: "Durand", prenom: "Claire", email: "claire.durand@example.test" },
          { nom: "Petit", prenom: "Paul", email: "paul.petit@example.test" },
        ],
      }),
    ).toEqual([
      {
        email: "claire.durand@example.test",
        name: "Claire Durand",
        field: "source_property_features.manager.contacts[0].email",
        principal: true,
        addressKind: "nominative",
      },
      {
        email: "paul.petit@example.test",
        name: "Paul Petit",
        field: "source_property_features.manager.contacts[1].email",
        principal: false,
        addressKind: "nominative",
      },
    ]);
  });

  it("les mots d'une boîte fonctionnelle sont ceux du pipeline, mot pour mot", () => {
    const python = readFileSync(
      resolve(process.cwd(), "services/data-pipeline/src/sources/cessions_etat_page.py"),
      "utf8",
    );
    const definition = python.match(/_FUNCTIONAL_MAILBOX_RE = re\.compile\(([\s\S]*?)re\.I,/);
    expect(definition).not.toBeNull();
    const words = [...(definition?.[1] ?? "").matchAll(/r"([^"]*)"/g)]
      .map((match) => match[1])
      .join("")
      .replace(/^\(\?:/, "")
      .replace(/\)$/, "")
      .split("|");
    expect(words).toEqual([...INFORMATION_AGENT_STATE_FUNCTIONAL_MAILBOX_WORDS]);
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

describe("office notarial de la vente", () => {
  it("un seul code publié : il vaut pour tout notaire retenu (champ, texte, registre)", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...NOTAIRES,
        features: { listing: { office_crpcen: "33001" }, contact: { email: "etude@example.test" } },
        sale: {
          lawyer_contact: "jean.martin@example.test",
          source_blocks: { notaire: "Me Paul Petit, notaire : paul.petit@example.test" },
        },
        registry: [
          {
            email: "anne.leroy@example.test",
            displayName: "Anne Leroy",
            role: "notary",
            sourceName: "notaires",
            sourceUrl: NOTAIRES.url,
            observedAt: "2026-11-10T10:00:00.000Z",
          },
        ],
      }),
    );
    expect(resolution.officeCode).toBe("33001");
    expect(
      resolution.candidates
        .filter((candidate) => candidate.role === "notary")
        .map((candidate) => [candidate.email, candidate.officeCode])
        .sort(),
    ).toEqual([
      ["anne.leroy@example.test", "33001"],
      ["etude@example.test", "33001"],
      ["jean.martin@example.test", "33001"],
      ["paul.petit@example.test", "33001"],
    ]);
  });

  it("deux codes publiés (annonces fusionnées de deux offices) : aucun code commun n'est inventé", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...NOTAIRES,
        observations: [
          {
            source: "notaires",
            url: "https://annonces.example.test/notaires/vente-1-bis",
            features: {
              contact: { name: "Anne Leroy", email: "anne.leroy@example.test" },
              listing: { office_crpcen: "75012" },
            },
          },
        ],
        sale: { lawyer_contact: "etude.fictive@gmail.test" },
      }),
    );
    expect(resolution.officeCode).toBeNull();
    const byEmail = new Map(resolution.candidates.map((c) => [c.email, c.officeCode]));
    expect(byEmail.get("jean.martin@example.test")).toBe("33001");
    expect(byEmail.get("anne.leroy@example.test")).toBe("75012");
    expect(byEmail.get("etude.fictive@gmail.test")).toBeUndefined();
  });

  it("le code d'office ne va qu'aux candidats de rôle notaire", () => {
    // Organisateur déclaré « avocat poursuivant » sur une annonce de `notaires` : aucun notaire retenu,
    // donc personne ne porte le code, bien que l'annonce le publie.
    const resolution = resolveInformationAgentListingContacts(
      sale({ ...NOTAIRES, organizerType: "pursuing_lawyer" }),
    );
    expect(resolution.officeCode).toBe("33001");
    expect(resolution.candidates.map((candidate) => candidate.role)).toEqual(["source_contact"]);
    expect(resolution.candidates.every((candidate) => !candidate.officeCode)).toBe(true);
  });

  it.each([
    ["`sale_procedure` nul", null],
    ["organisateur `unknown`", { organizer_type: "unknown" }],
    ["organisateur hors liste", { organizer_type: "seller" }],
  ])(
    "organisateur non déclaré (%s) : le code unique vaut quand même pour tout notaire",
    (_l, p) => {
      const resolution = resolveInformationAgentListingContacts(
        sale({
          source: "notaires",
          url: NOTAIRES.url,
          features: NOTAIRES.features,
          sale: {
            sale_procedure: p,
            lawyer_contact: "autre.notaire@exemple-fictif.notaires.fr",
          },
        }),
      );
      expect(resolution.organizerType).toBe("unknown");
      expect(resolution.officeCode).toBe("33001");
      expect(resolution.candidates.map((c) => [c.email, c.role, c.officeCode]).sort()).toEqual([
        ["autre.notaire@exemple-fictif.notaires.fr", "notary", "33001"],
        ["jean.martin@example.test", "notary", "33001"],
      ]);
    },
  );
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

  it("vente notariale : le bloc `contact` d'une observation d'une autre source n'est pas « notaire »", () => {
    const resolution = resolveInformationAgentListingContacts(
      sale({
        ...NOTAIRES,
        observations: [
          {
            source: "petites_affiches",
            url: "https://annonces.example.test/petites-affiches/9",
            features: { contact: { email: "maitre.durand@example.test" } },
          },
        ],
      }),
    );
    const other = resolution.candidates.find((c) => c.email === "maitre.durand@example.test");
    expect(other).toMatchObject({ role: "source_contact", recipientKind: "source_contact" });
    expect(other?.structureKind).toBeUndefined();
    expect(other?.provenance[0]).toMatchObject({
      sourceName: "petites_affiches",
      sourceUrl: "https://annonces.example.test/petites-affiches/9",
    });
    // Le notaire de la source `notaires` reste l'interlocuteur choisi seul.
    expect(selectInformationAgentContact(resolution.candidates)?.email).toBe(
      "jean.martin@example.test",
    );
  });

  it("le registre interne passe par le même filtre de rôle, refus compté", () => {
    const registry: InformationAgentRegistryContact[] = [
      {
        email: "maitre.durand@example.test",
        displayName: "Maître Durand, Avocat",
        role: "lawyer",
        sourceName: "licitor",
        sourceUrl: "https://annonces.example.test/licitor/1",
        observedAt: "2026-11-10T10:00:00.000Z",
      },
    ];
    const notarial = resolveInformationAgentListingContacts(sale({ ...NOTAIRES, registry }));
    expect(notarial.candidates.map((candidate) => candidate.email)).toEqual([
      "jean.martin@example.test",
    ]);
    expect(notarial.refused).toEqual({ role_not_sale_interlocutor: 1 });
    // Un notaire au registre d'une vente au tribunal : écarté de même.
    const tribunal = resolveInformationAgentListingContacts(
      sale({ ...ENCHERES_IMMOBILIERES, registry: [{ ...registry[0], role: "notary" }] }),
    );
    expect(tribunal.candidates.map((candidate) => candidate.email)).toEqual([
      "anne.leroy@example.test",
    ]);
    expect(tribunal.refused).toEqual({ role_not_sale_interlocutor: 1 });
  });

  it.each(["notaires", "cessions_etat"])(
    "source `%s` : un texte libre ne fait jamais un avocat (« cabinet », « avocat »)",
    (source) => {
      const texts = {
        description: "Avocat : maitre.durand@example.test",
        source_blocks: { cabinet: "Cabinet Martin : cabinet.martin@example.test" },
      };
      const roles = (fixtureSource: string) =>
        Object.fromEntries(
          discoverInformationAgentContacts(
            sale({
              source: fixtureSource,
              url: `https://annonces.example.test/${fixtureSource}/7`,
              sale: { sale_procedure: procedure, ...texts },
            }),
          ).map((candidate) => [candidate.email, [candidate.role, candidate.recipientKind]]),
        );
      // Organisateur déclaré « avocat poursuivant » sur cette source : pas un avocat, un contact à confirmer.
      const procedure: unknown = { organizer_type: "pursuing_lawyer" };
      expect(roles(source)).toEqual({
        "maitre.durand@example.test": ["source_contact", "source_contact"],
        "cabinet.martin@example.test": ["source_contact", "source_contact"],
      });
      // Les mêmes textes sur une source d'annonces judiciaires : inchangé.
      expect(roles("licitor")).toEqual({
        "maitre.durand@example.test": ["lawyer", "source_lawyer"],
        "cabinet.martin@example.test": ["lawyer", "source_lawyer"],
      });
    },
  );

  it.each([
    ["notaires", null],
    ["notaires", { organizer_type: "unknown" }],
    ["cessions_etat", null],
    ["cessions_etat", { organizer_type: "seller" }],
  ])(
    "source `%s`, organisateur non déclaré (%j) : un bloc « avocat » est refusé comme interlocuteur",
    (source, saleProcedure) => {
      const resolution = resolveInformationAgentListingContacts(
        sale({
          source,
          url: `https://annonces.example.test/${source}/8`,
          sale: {
            sale_procedure: saleProcedure,
            description: "Cabinet Martin : cabinet.martin@example.test",
            source_blocks: { contact_avocat: "Me Durand, maitre.durand@example.test" },
          },
          registry: [
            {
              email: "anne.leroy@example.test",
              displayName: "Maître Anne Leroy, Avocat",
              role: "lawyer",
              sourceName: source,
              sourceUrl: `https://annonces.example.test/${source}/8`,
              observedAt: "2026-11-10T10:00:00.000Z",
            },
          ],
        }),
      );
      // Ni candidat « contact de l'annonce » choisi seul, ni avocat : refusés, comme sur une vente déclarée.
      expect(resolution.candidates).toEqual([]);
      expect(selectInformationAgentContact(resolution.candidates)).toBeNull();
      expect(resolution.refused).toEqual({ role_not_sale_interlocutor: 3 });
    },
  );

  it("sur une source d'annonces judiciaires sans organisateur déclaré, le même bloc reste un avocat", () => {
    const [candidate] = discoverInformationAgentContacts(
      sale({
        source: "licitor",
        url: "https://annonces.example.test/licitor/8",
        sale: {
          sale_procedure: null,
          source_blocks: { contact_avocat: "Me Durand, maitre.durand@example.test" },
        },
      }),
    );
    expect(candidate).toMatchObject({ email: "maitre.durand@example.test", role: "lawyer" });
  });

  it("description : le rôle se lit dans la phrase qui précède l'adresse, pas dans tout le texte", () => {
    // Annonce `notaires` : « cabinet de toilette » décrit le bien, pas le titulaire de l'adresse.
    const office = resolveInformationAgentListingContacts(
      sale({
        source: "notaires",
        url: NOTAIRES.url,
        organizerType: "notary",
        sale: {
          description:
            "Maison de 120 m² avec trois chambres et un cabinet de toilette. Renseignements auprès de l'office : etude@example.test",
        },
      }),
    );
    expect(office.candidates.map((c) => [c.email, c.role])).toEqual([
      ["etude@example.test", "source_contact"],
    ]);
    expect(office.refused).toEqual({});

    // Cession de l'État : « devant notaire » décrit l'acte à venir, pas le service à contacter.
    const cession = resolveInformationAgentListingContacts(
      sale({
        source: "cessions_etat",
        url: CESSIONS.url,
        organizerType: "state_service",
        sale: {
          description:
            "L'acte de vente sera signé devant notaire dans les trois mois.\nContact du service : pgp.domaine@example.test",
        },
      }),
    );
    expect(cession.candidates.map((c) => [c.email, c.role])).toEqual([
      ["pgp.domaine@example.test", "source_contact"],
    ]);
    expect(cession.refused).toEqual({});

    // La phrase qui précède l'adresse, elle, compte toujours.
    const cited = resolveInformationAgentListingContacts(
      sale({
        source: "notaires",
        url: NOTAIRES.url,
        organizerType: "notary",
        sale: {
          description:
            "Maison avec jardin. Avocat du vendeur pour toute question : maitre.durand@example.test",
        },
      }),
    );
    expect(cited.candidates).toEqual([]);
    expect(cited.refused).toEqual({ not_sale_interlocutor: 1 });
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

describe("table des rôles des blocs, par organisateur", () => {
  const role = (
    block: "contact" | "manager" | "lawyer",
    organizerType: InformationAgentOrganizerType,
    sourceName: string | null = null,
    lawyerAddress = false,
  ) => informationAgentListingBlockRole({ block, organizerType, sourceName, lawyerAddress })?.role;

  it("vente notariale : le contact n'est notaire que sur la source `notaires`", () => {
    expect(role("contact", "notary", "notaires")).toBe("notary");
    expect(role("contact", "notary", "petites_affiches")).toBe("source_contact");
    expect(role("contact", "notary")).toBe("source_contact");
    expect(role("lawyer", "notary", "notaires")).toBeUndefined();
    expect(role("manager", "notary", "cessions_etat")).toBeUndefined();
  });
  it("cession de l'État : le gestionnaire de la source `cessions_etat`, rien d'autre", () => {
    expect(
      informationAgentListingBlockRole({
        block: "manager",
        organizerType: "state_service",
        sourceName: "cessions_etat",
        lawyerAddress: false,
      }),
    ).toEqual({ role: "organizer", structureKind: "state_service" });
    expect(role("manager", "state_service", "licitor")).toBeUndefined();
    expect(role("contact", "state_service", "notaires")).toBeUndefined();
    expect(role("lawyer", "state_service")).toBeUndefined();
  });
  it("avocat poursuivant : le bloc avocat ; le bloc contact seulement si c'est son adresse", () => {
    expect(role("lawyer", "pursuing_lawyer")).toBe("lawyer");
    expect(role("contact", "pursuing_lawyer", "avoventes", true)).toBe("lawyer");
    expect(role("contact", "pursuing_lawyer", "avoventes", false)).toBe("source_contact");
    expect(role("contact", "pursuing_lawyer", "notaires", true)).toBe("source_contact");
    expect(role("manager", "pursuing_lawyer", "cessions_etat")).toBeUndefined();
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
  });

  it("une adresse du registre, décodée à la collecte, n'est pas dite « publiée dans l'annonce »", () => {
    const shown = profile(LICITOR);
    expect(shown).toMatchObject({
      roleLabel: "Avocat",
      addressKind: "nominative",
      originLabel: "Adresse relevée à la collecte de l’annonce (masquée sur la page)",
      originSourceName: "licitor",
      originUrl: LICITOR.url,
    });
    expect(shown?.originLabel).not.toContain("publiée");
  });

  it("libellé, source et lien viennent de la même provenance", () => {
    // Première provenance sans lien, seconde avec lien d'une autre source : le lien n'est pas emprunté.
    const shown = informationAgentRecipientProfile(
      {
        contact_discovery: {
          candidates: [
            {
              email: "jeanne.exemple@example.test",
              role: "lawyer",
              provenance: [
                {
                  kind: "source_block",
                  field: "information_agent_contacts",
                  source_name: "licitor",
                  source_url: null,
                },
                {
                  kind: "source_text",
                  field: "description",
                  source_name: "avoventes",
                  source_url: "https://annonces.example.test/avoventes/lot-4",
                },
              ],
            },
          ],
        },
      },
      "jeanne.exemple@example.test",
    );
    expect(shown).toMatchObject({
      originLabel: "Adresse relevée à la collecte de l’annonce (masquée sur la page)",
      originSourceName: "licitor",
      originUrl: null,
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
