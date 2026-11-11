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
  INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE,
  informationAgentAddressKind,
  normalizedOfficeCode,
  type InformationAgentAddressKind,
  type InformationAgentStructureKind,
} from "@/lib/information-agent/contact-structure";
import { normalizeInformationAgentIdentityName } from "@/lib/information-agent/identity";

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
  /** Générique ou nominative ; la boîte de service d'une cession est générique par désignation du pipeline. */
  addressKind: InformationAgentAddressKind;
};

/**
 * Mots d'une boîte fonctionnelle d'un service de l'État. SOURCE UNIQUE : le pipeline, qui choisit
 * `manager.direction_email` avec ces mots (`_FUNCTIONAL_MAILBOX_RE`,
 * `services/data-pipeline/src/sources/cessions_etat_page.py`, lignes 41 à 45). Cette copie ne sert qu'à
 * relire SON choix : quand aucune boîte fonctionnelle n'est publiée, le pipeline retient la première adresse,
 * qui est alors celle d'une personne. Un test compare les deux listes mot pour mot.
 */
export const INFORMATION_AGENT_STATE_FUNCTIONAL_MAILBOX_WORDS: readonly string[] = [
  "pole",
  "gestion",
  "domain",
  "pgp",
  "service",
  "ddfip",
  "drfip",
  "dgfip",
  "sgami",
  "cession",
  "immobilier",
  "patrimoine",
  "prie",
  "france-domaine",
  "bureau",
  "direction",
  "secretariat",
  "contact",
  "accueil",
];
const STATE_FUNCTIONAL_MAILBOX = new RegExp(
  `(?:${INFORMATION_AGENT_STATE_FUNCTIONAL_MAILBOX_WORDS.join("|")})`,
  "i",
);

/** Nature de l'adresse que le pipeline désigne comme boîte du service (`direction_email`). */
function serviceMailboxKind(email: string): InformationAgentAddressKind {
  return STATE_FUNCTIONAL_MAILBOX.test(email.split("@", 1)[0])
    ? "generic"
    : informationAgentAddressKind(email);
}

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
      addressKind: informationAgentAddressKind(email),
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
  // La boîte du service d'abord, quelle que soit sa forme : c'est l'adresse que le pipeline désigne pour une
  // demande d'information. Elle n'a pas de nom de personne.
  for (const email of emailsOf(manager.direction_email)) {
    addManager({
      email,
      name: null,
      field: "source_property_features.manager.direction_email",
      principal: true,
      addressKind: serviceMailboxKind(email),
    });
  }
  // Puis les personnes : chaque adresse reste associée au nom que l'annonce lui donne. Le gestionnaire nommé
  // se reconnaît à son nom normalisé (« DURAND Marie » et « Marie Durand » sont la même personne).
  const namedManager = normalizeInformationAgentIdentityName(managerName);
  const people: InformationAgentListingContactRecord[] = [];
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
        people.push({
          email,
          name,
          field: `source_property_features.manager.${listKey}[${index}].email`,
          principal:
            namedManager.length > 0 && normalizeInformationAgentIdentityName(name) === namedManager,
          addressKind: informationAgentAddressKind(email),
        });
      }
    });
  }
  // Aucune personne ne porte le nom du gestionnaire (l'annonce nomme un service, ou personne) : la première
  // personne listée est le contact de la vente.
  if (people.length && !people.some((record) => record.principal)) {
    people[0] = { ...people[0], principal: true };
  }
  people.forEach(addManager);
  for (const email of emailsOf(manager.email)) {
    addManager({
      email,
      name: managerRecords.length ? null : managerName,
      field: "source_property_features.manager.email",
      principal: true,
      addressKind: informationAgentAddressKind(email),
    });
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

const LAWYER: InformationAgentListingRole = {
  role: "lawyer",
  structureKind: INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE.lawyer,
};
const NOTARY: InformationAgentListingRole = {
  role: "notary",
  structureKind: INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE.notary,
};
// Un organisateur n'a de structure connue que désigné par la source des cessions de l'État.
const STATE: InformationAgentListingRole = { role: "organizer", structureKind: "state_service" };
const PLAIN: InformationAgentListingRole = { role: "source_contact", structureKind: null };

/**
 * Rôle que la SOURCE de l'annonce donne à son contact : `notaires` ne publie que des notaires,
 * `cessions_etat` que des services de l'État. Les autres sources ne disent rien.
 */
export function informationAgentSourceRole(
  sourceName: string | null,
): InformationAgentListingRole | null {
  if (sourceName === "notaires") return NOTARY;
  if (sourceName === "cessions_etat") return STATE;
  return null;
}

/**
 * Organisateur que la source implique quand la procédure n'en déclare pas : `notaires` ne publie que des
 * ventes notariales, `cessions_etat` que des cessions de l'État. Un organisateur déclaré n'est jamais remplacé.
 */
export function informationAgentImpliedOrganizerType(
  organizerType: InformationAgentOrganizerType,
  sourceName: string | null,
): InformationAgentOrganizerType {
  if (organizerType !== "unknown") return organizerType;
  const bySource = informationAgentSourceRole(sourceName);
  if (bySource === NOTARY) return "notary";
  if (bySource === STATE) return "state_service";
  return "unknown";
}

/**
 * Rôle d'un bloc de contact pour cette vente, ou `null` si le bloc ne désigne pas l'interlocuteur de la
 * vente (il est alors écarté). TABLE FERMÉE ; la source est celle du bloc (vente ou observation fusionnée).
 *
 * | organisateur       | `contact`                           | `manager`              | `lawyer` |
 * | vente notariale    | notaire si la source est `notaires`,| écarté                 | écarté   |
 * |                    | sinon contact de l'annonce          |                        |          |
 * | cession de l'État  | écarté                              | service de l'État si   | écarté   |
 * |                    |                                     | la source est          |          |
 * |                    |                                     | `cessions_etat`        |          |
 * | avocat poursuivant | avocat si l'adresse est aussi celle | écarté                 | avocat   |
 * |                    | de l'avocat et que la source n'est  |                        |          |
 * |                    | ni `notaires` ni `cessions_etat`,   |                        |          |
 * |                    | sinon contact de l'annonce          |                        |          |
 * | inconnu            | notaire si la source est `notaires`,| service de l'État si   | avocat   |
 * |                    | sinon contact de l'annonce          | la source est          |          |
 * |                    |                                     | `cessions_etat`        |          |
 *
 * « Contact de l'annonce » (`source_contact`) n'est jamais choisi seul devant un interlocuteur désigné.
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
  const bySource = informationAgentSourceRole(sourceName);
  if (block === "lawyer") {
    return organizerType === "notary" || organizerType === "state_service" ? null : LAWYER;
  }
  if (block === "manager") {
    const stateSale = organizerType === "state_service" || organizerType === "unknown";
    return stateSale && bySource === STATE ? STATE : null;
  }
  if (organizerType === "state_service") return null;
  if (organizerType === "pursuing_lawyer") return lawyerAddress && !bySource ? LAWYER : PLAIN;
  return bySource === NOTARY ? NOTARY : PLAIN;
}

/**
 * Rôle du contact porté par le champ `lawyer_contact`. Le nom du champ ne dit RIEN : le pipeline y projette
 * le contact de l'organisateur quel qu'il soit (avocat, notaire, service de l'État). Le rôle vient donc de
 * l'organisateur de la vente et de la source, jamais du mot « lawyer ».
 *
 * - vente notariale : notaire si la source est `notaires`, sinon contact de l'annonce ;
 * - cession de l'État : service de l'État si la source est `cessions_etat`, sinon contact de l'annonce ;
 * - avocat poursuivant : avocat, sauf sur une source `notaires` ou `cessions_etat` (contact de l'annonce) ;
 * - organisateur inconnu, absent ou hors liste : le rôle de la source ; à défaut, avocat seulement si un
 *   bloc `lawyer` de l'annonce porte la même adresse ; sinon contact de l'annonce.
 */
export function informationAgentSaleFieldRole({
  organizerType,
  sourceName,
  lawyerAddress,
}: {
  organizerType: InformationAgentOrganizerType;
  sourceName: string | null;
  /** Un bloc `lawyer` de l'annonce porte cette adresse. */
  lawyerAddress: boolean;
}): InformationAgentListingRole {
  const bySource = informationAgentSourceRole(sourceName);
  switch (organizerType) {
    case "notary":
      return bySource === NOTARY ? NOTARY : PLAIN;
    case "state_service":
      return bySource === STATE ? STATE : PLAIN;
    case "pursuing_lawyer":
      return bySource ? PLAIN : LAWYER;
    case "unknown":
      return bySource ?? (lawyerAddress ? LAWYER : PLAIN);
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
