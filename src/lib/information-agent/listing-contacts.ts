/**
 * Interlocuteurs publiés dans l'annonce elle-même, lus dans `raw_payload.source_property_features` :
 * contact de l'office notarial (`contact`), service gestionnaire de l'État (`manager`), avocat de la vente
 * (`lawyer`). MODULE PUR : aucun accès réseau ni base ; il ne lit que des données déjà collectées.
 *
 * Qui est l'interlocuteur dépend de la vente (`sale_procedure.organizer_type`) : le notaire d'une vente
 * notariale, le service de l'État d'une cession, l'avocat poursuivant sinon. Un notaire ou un avocat cité à
 * un autre titre (conseil d'une partie, syndic, liquidateur…) n'est jamais retenu.
 */
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { findEmailsInText } from "@/lib/information-agent/email-in-text";
import {
  normalizedOfficeCode,
  type InformationAgentStructureKind,
} from "@/lib/information-agent/contact-structure";

export const INFORMATION_AGENT_ORGANIZER_TYPES = [
  "pursuing_lawyer",
  "notary",
  "state_service",
  "unknown",
] as const;

export type InformationAgentOrganizerType = (typeof INFORMATION_AGENT_ORGANIZER_TYPES)[number];

export type InformationAgentListingBlockName = "contact" | "manager" | "lawyer";

/** Une adresse publiée et la personne (ou le service) à laquelle l'annonce l'associe. */
export type InformationAgentListingContactRecord = {
  email: string;
  name: string | null;
  /** Chemin du champ lu, pour la provenance (`source_property_features.contact.email`…). */
  field: string;
  /**
   * L'annonce associe cette adresse au contact qu'elle nomme pour la vente. Faux pour les autres personnes
   * d'une liste (`manager.managers[1..]`) : leur adresse nominative n'est jamais retenue.
   */
  principal: boolean;
};

/** Blocs de contact d'une annonce (la vente, ou l'observation d'une autre source fusionnée). */
export type InformationAgentListingContactBlock = {
  sourceName: string | null;
  sourceUrl: string | null;
  /** Code de l'office notarial (`listing.office_crpcen`), identifiant stable de la structure. */
  officeCode: string | null;
  contact: InformationAgentListingContactRecord[];
  manager: InformationAgentListingContactRecord[];
  lawyer: InformationAgentListingContactRecord[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 180) : null;
}

function emailsOf(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      findEmailsInText(value)
        .map(normalizedEmail)
        .filter((email): email is string => Boolean(email)),
    ),
  ];
}

/** `organizer_type` de la procédure de vente ; toute valeur absente ou hors liste vaut `unknown`. */
export function readInformationAgentOrganizerType(
  ...procedures: unknown[]
): InformationAgentOrganizerType {
  for (const procedure of procedures) {
    const value = asRecord(procedure).organizer_type;
    if (
      typeof value === "string" &&
      (INFORMATION_AGENT_ORGANIZER_TYPES as readonly string[]).includes(value) &&
      value !== "unknown"
    ) {
      return value as InformationAgentOrganizerType;
    }
  }
  return "unknown";
}

/**
 * Lit les blocs de contact de `source_property_features`. Seules les formes produites par le pipeline sont
 * lues (liste fermée) :
 * - `contact` : `name`, `email` ;
 * - `lawyer` : `name`, `email` ;
 * - `manager` : `manager_name`, `email`, `direction_email`, `managers[]` (`name`, `email`) et l'ancienne
 *   forme `contacts[]` (`nom`, `prenom`, `email`) ;
 * - `listing.office_crpcen`.
 * Rend `null` quand aucun bloc ne porte d'adresse.
 */
export function readInformationAgentListingContactBlock(
  features: unknown,
  sourceName: string | null,
  sourceUrl: string | null,
): InformationAgentListingContactBlock | null {
  const root = asRecord(features);
  const single = (
    block: InformationAgentListingBlockName,
  ): InformationAgentListingContactRecord[] => {
    const value = asRecord(root[block]);
    return emailsOf(value.email).map((email) => ({
      email,
      name: text(value.name),
      field: `source_property_features.${block}.email`,
      principal: true,
    }));
  };

  const manager = asRecord(root.manager);
  const managerName = text(manager.manager_name);
  const managerRecords: InformationAgentListingContactRecord[] = [];
  const seen = new Set<string>();
  const addManager = (record: InformationAgentListingContactRecord) => {
    if (seen.has(record.email)) return;
    seen.add(record.email);
    managerRecords.push(record);
  };
  // Les personnes d'abord : chaque adresse reste associée au nom que l'annonce lui donne.
  for (const [listKey, list] of [
    ["managers", manager.managers],
    ["contacts", manager.contacts],
  ] as const) {
    if (!Array.isArray(list)) continue;
    list.forEach((raw, index) => {
      const person = asRecord(raw);
      const name =
        text(person.name) ??
        text([text(person.prenom), text(person.nom)].filter(Boolean).join(" "));
      for (const email of emailsOf(person.email)) {
        addManager({
          email,
          name,
          field: `source_property_features.manager.${listKey}[${index}].email`,
          principal: Boolean(name) && name === managerName,
        });
      }
    });
  }
  // Boîte du service (`direction_email`, reprise dans `email`) : absente de la liste, elle n'a pas de nom.
  for (const email of emailsOf(manager.direction_email)) {
    addManager({
      email,
      name: null,
      field: "source_property_features.manager.direction_email",
      principal: true,
    });
  }
  for (const email of emailsOf(manager.email)) {
    addManager({
      email,
      name: managerRecords.length ? null : managerName,
      field: "source_property_features.manager.email",
      principal: true,
    });
  }
  // Aucun nom de gestionnaire dans l'annonce : la première personne listée est le contact de la vente.
  if (managerRecords.length && !managerRecords.some((record) => record.principal)) {
    managerRecords[0] = { ...managerRecords[0], principal: true };
  }

  const block: InformationAgentListingContactBlock = {
    sourceName,
    sourceUrl,
    officeCode: normalizedOfficeCode(asRecord(root.listing).office_crpcen),
    contact: single("contact"),
    manager: managerRecords,
    lawyer: single("lawyer"),
  };
  return block.contact.length || block.manager.length || block.lawyer.length ? block : null;
}

export type InformationAgentListingRole = {
  role: "lawyer" | "notary" | "organizer" | "source_contact";
  structureKind: InformationAgentStructureKind | null;
};

/**
 * Rôle d'un bloc de contact pour cette vente, ou `null` si le bloc ne désigne pas l'interlocuteur de la
 * vente (il est alors écarté). TABLE FERMÉE :
 *
 * | organisateur      | `contact`                         | `manager`            | `lawyer` |
 * | vente notariale   | notaire                           | écarté               | écarté   |
 * | cession de l'État | écarté                            | service de l'État    | écarté   |
 * | avocat poursuivant| avocat si l'adresse est aussi     | écarté               | avocat   |
 * |                   | celle de l'avocat, sinon contact  |                      |          |
 * | inconnu           | notaire (source `notaires`),      | service de l'État    | avocat   |
 * |                   | sinon contact de l'annonce        | (source              |          |
 * |                   |                                   | `cessions_etat`)     |          |
 *
 * « Contact de l'annonce » (`source_contact`) n'est jamais choisi seul quand un interlocuteur désigné existe :
 * l'administrateur tranche.
 */
export function informationAgentListingBlockRole({
  block,
  organizerType,
  sourceName,
  lawyerAddress,
}: {
  block: InformationAgentListingBlockName;
  organizerType: InformationAgentOrganizerType;
  sourceName: string | null;
  /** L'adresse du bloc `contact` est aussi celle que l'annonce donne pour l'avocat. */
  lawyerAddress: boolean;
}): InformationAgentListingRole | null {
  const lawyer: InformationAgentListingRole = { role: "lawyer", structureKind: "law_firm" };
  const notary: InformationAgentListingRole = { role: "notary", structureKind: "notary_office" };
  const state: InformationAgentListingRole = { role: "organizer", structureKind: "state_service" };
  const plain: InformationAgentListingRole = { role: "source_contact", structureKind: null };
  switch (organizerType) {
    case "notary":
      return block === "contact" ? notary : null;
    case "state_service":
      return block === "manager" ? state : null;
    case "pursuing_lawyer":
      if (block === "lawyer") return lawyer;
      if (block === "contact") return lawyerAddress ? lawyer : plain;
      return null;
    case "unknown":
      if (block === "lawyer") return lawyer;
      if (block === "contact") return sourceName === "notaires" ? notary : plain;
      return sourceName === "cessions_etat" ? state : null;
  }
}

/**
 * Un rôle lu dans un texte libre (bloc, description) est-il celui de l'interlocuteur de cette vente ? Un avocat
 * cité dans une vente notariale ou une cession de l'État, ou un notaire cité dans une vente au tribunal, y
 * figure à un autre titre : il est écarté. Organisateur inconnu : rien n'est écarté sur ce critère.
 */
export function isInterlocutorRoleForSale(
  role: "lawyer" | "notary" | "organizer" | "source_contact",
  organizerType: InformationAgentOrganizerType,
): boolean {
  if (organizerType === "notary") return role !== "lawyer";
  if (organizerType === "state_service") return role !== "lawyer" && role !== "notary";
  if (organizerType === "pursuing_lawyer") return role !== "notary";
  return true;
}

/**
 * Qualités qui ne sont pas celles de l'interlocuteur de la vente. LISTE FERMÉE, comparée sans accents ni
 * casse au nom du champ et au texte qui précède l'adresse dans la même ligne ou la même phrase.
 */
const NON_INTERLOCUTOR_PATTERNS: readonly RegExp[] = [
  /\bsyndic\b/,
  /\bsyndicat des coproprietaires\b/,
  /\b(?:avocat|conseil|notaire)s? (?:du|de la|de l|des) (?:debiteur|debitrice|saisi|saisie|partie saisie|defendeur|defenderesse|creancier inscrit|creanciers inscrits|colicitant|colicitants|locataire|occupant|vendeur|acquereur)/,
  /\bpartie saisie\b/,
  /\bdebiteur saisi\b/,
  /\bliquidateur\b/,
  /\bmandataire (?:judiciaire|liquidateur)\b/,
  /\badministrateur judiciaire\b/,
  /\bcreanciers? inscrits?\b/,
  /\blocataire\b/,
  /\boccupant\b/,
];
const NON_INTERLOCUTOR_FIELD =
  /syndic|debiteur|partie_saisie|liquidateur|mandataire|creancier_inscrit|locataire|occupant|colicitant/;
const CONTEXT_WINDOW = 160;

function plain(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * L'adresse est-elle citée à un autre titre que celui d'interlocuteur de la vente ? `value` est le texte
 * complet où elle figure ; seul ce qui la précède dans la même ligne ou la même phrase est examiné.
 */
export function isNonInterlocutorMention(field: string, value: string, email: string): boolean {
  if (NON_INTERLOCUTOR_FIELD.test(plain(field).replace(/[\s.-]/g, "_"))) return true;
  const index = value.toLowerCase().indexOf(email.toLowerCase());
  if (index < 0) return false;
  const before = value.slice(Math.max(0, index - CONTEXT_WINDOW), index);
  const sentence = before.split(/[\n\r|;]|\.\s/).pop() ?? "";
  const context = plain(sentence);
  return NON_INTERLOCUTOR_PATTERNS.some((pattern) => pattern.test(context));
}
