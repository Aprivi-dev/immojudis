/**
 * Structure d'un destinataire de l'agent d'information (cabinet, office notarial, service de l'État) et
 * nature de son adresse (générique ou nominative). MODULE PUR : aucun accès réseau ni base.
 *
 * Règle de préférence (décision du propriétaire du 11/11/2026) : quand un même bloc de contact de l'annonce
 * donne plusieurs adresses, l'adresse générique de la structure passe avant l'adresse nominative de la
 * personne nommée : quelqu'un de la structure saura transmettre la demande. L'adresse nominative d'une autre
 * personne que celle nommée n'est jamais retenue (`contact-resolution.ts`).
 */
import { isConsumerMailAddress, mailDomainOf } from "@/lib/information-agent/address-hygiene";

export type InformationAgentAddressKind = "generic" | "nominative";

const INFORMATION_AGENT_STRUCTURE_KINDS = ["law_firm", "notary_office", "state_service"] as const;

export type InformationAgentStructureKind = (typeof INFORMATION_AGENT_STRUCTURE_KINDS)[number];

/** Seul contrôle d'une valeur enregistrée (`metadata.contact_identity.structure_kind`). */
export function isInformationAgentStructureKind(
  value: unknown,
): value is InformationAgentStructureKind {
  return (INFORMATION_AGENT_STRUCTURE_KINDS as readonly unknown[]).includes(value);
}

/**
 * Structure que désigne un rôle établi, SEULE table rôle vers structure. `organizer` et `source_contact`
 * n'en désignent aucune à eux seuls (`null`).
 */
export const INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE = {
  lawyer: "law_firm",
  notary: "notary_office",
  organizer: null,
  source_contact: null,
} as const satisfies Record<string, InformationAgentStructureKind | null>;

/**
 * Mots qui font une adresse générique quelle que soit la suite (`contact@`, `contact.lyon@`,
 * `etude-dupont@`, `office12345@`) : accueil d'une structure, formes d'exercice, boîtes des services de
 * l'État qui gèrent les cessions. LISTE FERMÉE.
 */
export const INFORMATION_AGENT_GENERIC_LOCAL_PARTS: readonly string[] = [
  "contact",
  "contacts",
  "accueil",
  "info",
  "infos",
  "secretariat",
  "etude",
  "office",
  "cabinet",
  "scp",
  "selarl",
  "selas",
  "ddfip",
  "drfip",
  "dnid",
  "cessions",
  "pgp",
  "prie",
  "sgami",
];

/**
 * Mots ambigus : ce sont aussi des noms de famille ou des débuts d'adresse personnelle (`bureau.martin@`
 * est M. ou Mme Bureau, `domaine.durand@` un domaine viticole). Génériques SEULEMENT seuls ou suivis de
 * chiffres (`bureau@`, `ventes2@`). LISTE FERMÉE.
 */
export const INFORMATION_AGENT_GENERIC_LOCAL_PARTS_ALONE: readonly string[] = [
  "bureau",
  "courrier",
  "standard",
  "information",
  "informations",
  "domaine",
  "domaines",
  "notaires",
  "avocats",
  "negociation",
  "immobilier",
  "encheres",
  "ventes",
];

const GENERIC_WORDS = new Set(INFORMATION_AGENT_GENERIC_LOCAL_PARTS);
const GENERIC_WORDS_ALONE = new Set(INFORMATION_AGENT_GENERIC_LOCAL_PARTS_ALONE);

function localPartOf(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(0, at) : normalized;
}

/** Nature de l'adresse d'après sa partie locale ; tout ce qui n'est pas dans les deux listes est nominatif. */
export function informationAgentAddressKind(email: string): InformationAgentAddressKind {
  const local = localPartOf(email);
  const first = local.split(/[._+\-\d]/)[0] ?? "";
  if (GENERIC_WORDS.has(first)) return "generic";
  return GENERIC_WORDS_ALONE.has(first) && /^[a-z]+\d*$/.test(local) ? "generic" : "nominative";
}

/** Domaine de messagerie du notariat : une adresse qui y est logée est celle d'un office. */
const INFORMATION_AGENT_NOTARY_MAIL_DOMAIN = "notaires.fr";

/** L'adresse (ou le domaine) est-elle sur le domaine du notariat ou l'un de ses sous-domaines ? SEUL prédicat. */
export function isNotaryMailDomain(emailOrDomain: string): boolean {
  return (
    listedDomainOf([INFORMATION_AGENT_NOTARY_MAIL_DOMAIN], mailDomainOf(emailOrDomain)) !== null
  );
}

/**
 * Domaines où toute une profession ou une administration est logée par décision du propriétaire
 * (11/11/2026) : le PLAFOND du pilote y est compté par structure (office, service), avec un plafond bas pour
 * le domaine lui-même. LISTE FERMÉE, comparée au domaine exact ou à ses sous-domaines.
 */
export const INFORMATION_AGENT_SHARED_MAIL_DOMAINS: readonly string[] = [
  INFORMATION_AGENT_NOTARY_MAIL_DOMAIN,
  "gouv.fr",
];

/**
 * Autres domaines qui n'identifient aucune structure : messageries de profession et fournisseurs d'accès
 * français que la liste des messageries grand public (`address-hygiene.ts`) ne reconnaît pas. Aucune clé
 * d'opposition de structure n'y est jamais rattachée. Le plafond du pilote y reste compté par domaine (plus
 * strict). LISTE FERMÉE, comparée au domaine exact ou à ses sous-domaines.
 */
export const INFORMATION_AGENT_PROVIDER_MAIL_DOMAINS: readonly string[] = [
  // Messageries de profession
  "avocat.fr",
  "avocatline.fr",
  "avocat-conseil.fr",
  "nomade.fr",
  "justice.fr",
  // Fournisseurs d'accès et messageries français
  "aliceadsl.fr",
  "alice.fr",
  "cegetel.net",
  "noos.fr",
  "voila.fr",
  "nordnet.fr",
  "libertysurf.fr",
  "tiscali.fr",
  "dartybox.com",
  "9online.fr",
];

/**
 * Suffixes publics à deux niveaux : n'importe qui peut y enregistrer un nom (`association.asso.fr`,
 * `societe.co.uk`). Ce ne sont jamais des structures : aucune clé d'opposition n'y est portée ni contrôlée.
 * LISTE FERMÉE, comparée au domaine exact.
 */
export const INFORMATION_AGENT_PUBLIC_SUFFIXES: readonly string[] = [
  "asso.fr",
  "com.fr",
  "nom.fr",
  "prd.fr",
  "presse.fr",
  "tm.fr",
  "co.uk",
  "org.uk",
  "com.au",
  "co.nz",
];

function listedDomainOf(list: readonly string[], domain: string): string | null {
  return list.find((entry) => domain === entry || domain.endsWith(`.${entry}`)) ?? null;
}

/** Domaine partagé (plafond par structure) auquel l'adresse ou le domaine appartient, sinon `null`. */
export function sharedMailDomainOf(emailOrDomain: string): string | null {
  return listedDomainOf(INFORMATION_AGENT_SHARED_MAIL_DOMAINS, mailDomainOf(emailOrDomain));
}

/** Un domaine identifie-t-il une structure ? Ni partagé, ni messagerie de profession ou d'accès, ni grand public. */
function isOwnMailDomain(domain: string): boolean {
  return (
    domain.includes(".") &&
    !INFORMATION_AGENT_PUBLIC_SUFFIXES.includes(domain) &&
    !listedDomainOf(INFORMATION_AGENT_SHARED_MAIL_DOMAINS, domain) &&
    !listedDomainOf(INFORMATION_AGENT_PROVIDER_MAIL_DOMAINS, domain) &&
    !isConsumerMailAddress(`x@${domain}`)
  );
}

/**
 * Domaine propre à une structure (`cabinet-dupont.fr`) ; `null` pour `notaires.fr`, `avocat.fr`, `gmail.com`…
 * qui n'identifient personne.
 */
export function ownMailDomainOf(email: string): string | null {
  const domain = mailDomainOf(email);
  return domain && isOwnMailDomain(domain) ? domain : null;
}

/** Code d'office notarial (CRPCEN) : chiffres seuls, 4 à 6 ; toute autre forme est ignorée. */
export function normalizedOfficeCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).trim();
  return /^\d{4,6}$/.test(digits) ? digits : null;
}

/**
 * Clés d'opposition PORTÉES par une adresse de la structure, rangées dans la liste d'opposition par identité
 * (`information_agent_identity_oppositions`, texte libre en minuscules : aucune migration).
 *
 * - `structure|office|<crpcen>` : office notarial, quel que soit le domaine de ses adresses ;
 * - `structure|domain|<domaine>` : domaine PROPRE exact de l'adresse. Jamais un domaine partagé, une
 *   messagerie de profession ou grand public : une opposition y vaudrait pour des inconnus.
 *
 * Une clé de structure ne contient aucune adresse email.
 */
export function informationAgentStructureKeys({
  email,
  officeCode,
}: {
  email: string;
  officeCode?: string | null;
}): string[] {
  const keys: string[] = [];
  const office = normalizedOfficeCode(officeCode);
  if (office) keys.push(`structure|office|${office}`);
  const domain = ownMailDomainOf(email);
  if (domain) keys.push(`structure|domain|${domain}`);
  return keys;
}

/**
 * Clés à CONTRÔLER avant d'écrire à une adresse : celles qu'elle porte, plus celles des domaines parents
 * (au moins deux libellés, propres eux aussi). L'opposition de `cabinet-dupont.fr` vaut ainsi pour
 * `paris.cabinet-dupont.fr` ; l'inverse n'est pas vrai (un bureau qui s'oppose n'engage pas tout le cabinet).
 */
export function informationAgentStructureCheckKeys(input: {
  email: string;
  officeCode?: string | null;
}): string[] {
  const keys = informationAgentStructureKeys(input);
  const domain = ownMailDomainOf(input.email);
  if (!domain) return keys;
  const labels = domain.split(".");
  for (let start = 1; labels.length - start >= 2; start += 1) {
    const parent = labels.slice(start).join(".");
    if (isOwnMailDomain(parent)) keys.push(`structure|domain|${parent}`);
  }
  return keys;
}

/**
 * Code d'office à rattacher à une adresse. RÈGLE UNIQUE :
 * - l'adresse est celle d'un notaire que l'annonce désigne : son code (`officeCode`) ;
 * - sinon (adresse saisie par l'administrateur, contact sans code), le code de l'office de la vente
 *   (`saleOfficeCode`) vaut seulement si l'adresse n'a pas de domaine propre : sur `notaires.fr` ou une
 *   messagerie, seul l'office dit à quelle structure elle appartient. Une adresse sur un domaine propre est
 *   identifiée par ce domaine.
 */
export function informationAgentOfficeCodeFor({
  email,
  officeCode,
  saleOfficeCode,
}: {
  email: string;
  officeCode: string | null | undefined;
  saleOfficeCode: string | null | undefined;
}): string | null {
  return (
    normalizedOfficeCode(officeCode) ??
    (ownMailDomainOf(email) ? null : normalizedOfficeCode(saleOfficeCode))
  );
}

export function isInformationAgentStructureKey(key: string): boolean {
  return key.startsWith("structure|");
}

/**
 * Unité de plafond d'envoi d'un destinataire (pilote automatique).
 *
 * - hors domaine partagé : la structure est le domaine (`sharedDomain` nul), plafond par domaine inchangé ;
 * - domaine partagé : la structure est l'office (code) ou, sans code, la boîte elle-même ; le domaine
 *   partagé a en plus son propre plafond bas.
 *
 * `key` peut contenir une adresse (boîte sans code d'office) : elle sert au comptage en mémoire et n'est ni
 * journalisée ni enregistrée.
 */
export type InformationAgentCapStructure = { key: string; sharedDomain: string | null };

export function informationAgentCapStructure({
  email,
  officeCode,
}: {
  email: string;
  officeCode?: string | null;
}): InformationAgentCapStructure {
  const normalized = email.trim().toLowerCase();
  const domain = mailDomainOf(normalized);
  const sharedDomain = sharedMailDomainOf(domain);
  if (!sharedDomain) return { key: `domain|${domain}`, sharedDomain: null };
  const office = normalizedOfficeCode(officeCode);
  return { key: office ? `office|${office}` : `mailbox|${normalized}`, sharedDomain };
}

export const INFORMATION_AGENT_ADDRESS_KIND_LABELS: Record<InformationAgentAddressKind, string> = {
  generic: "Adresse générique de la structure",
  nominative: "Adresse nominative",
};
