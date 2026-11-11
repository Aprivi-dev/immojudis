/**
 * Structure d'un destinataire de l'agent d'information (cabinet, office notarial, service de l'État) et
 * nature de son adresse (générique ou nominative). MODULE PUR : aucun accès réseau ni base.
 *
 * Règle de préférence (décision du propriétaire du 11/11/2026) : quand plusieurs adresses existent pour un
 * même professionnel ou une même structure, l'adresse générique de la structure passe avant l'adresse
 * nominative de la personne nommée par l'annonce : quelqu'un de la structure saura transmettre la demande.
 * L'adresse nominative d'une autre personne que celle nommée n'est jamais retenue
 * (`listing-contacts.ts`, `addressBelongsToNamedPerson`).
 */
import { isConsumerMailAddress, mailDomainOf } from "@/lib/information-agent/address-hygiene";

export type InformationAgentAddressKind = "generic" | "nominative";

export type InformationAgentStructureKind = "law_firm" | "notary_office" | "state_service";

/**
 * Premiers mots d'une adresse générique de structure. LISTE FERMÉE : une adresse n'est générique que si
 * la partie locale commence par l'un de ces mots, seul ou suivi d'un séparateur ou de chiffres
 * (`contact@`, `contact.lyon@`, `etude-dupont@`, `office12345@`). Tout le reste est nominatif.
 *
 * Trois familles : accueil d'une structure, formes d'exercice d'un cabinet ou d'un office, services de
 * l'État qui gèrent les cessions (boîtes fonctionnelles des directions des finances publiques).
 */
export const INFORMATION_AGENT_GENERIC_LOCAL_PARTS: readonly string[] = [
  // Accueil
  "contact",
  "contacts",
  "accueil",
  "info",
  "infos",
  "information",
  "informations",
  "secretariat",
  "courrier",
  "standard",
  "bureau",
  // Cabinet ou office
  "etude",
  "office",
  "cabinet",
  "scp",
  "selarl",
  "selas",
  "notaires",
  "avocats",
  "negociation",
  "immobilier",
  "encheres",
  "ventes",
  // Services de l'État
  "ddfip",
  "drfip",
  "dnid",
  "domaine",
  "domaines",
  "cessions",
  "pgp",
  "prie",
  "sgami",
];

const GENERIC_WORDS = new Set(INFORMATION_AGENT_GENERIC_LOCAL_PARTS);

function localPartOf(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(0, at) : normalized;
}

/** Générique si le premier mot de la partie locale (avant `.`, `-`, `_`, `+` ou des chiffres) est dans la liste. */
export function informationAgentAddressKind(email: string): InformationAgentAddressKind {
  const first = localPartOf(email).split(/[._+\-\d]/)[0] ?? "";
  return GENERIC_WORDS.has(first) ? "generic" : "nominative";
}

/**
 * Domaines partagés par toute une profession ou une administration : l'adresse y est attribuée par un tiers
 * (notariat, État), le domaine ne dit rien de la structure. LISTE FERMÉE, comparée au domaine exact ou à ses
 * sous-domaines (`paris.notaires.fr`, `dgfip.finances.gouv.fr`).
 */
export const INFORMATION_AGENT_SHARED_MAIL_DOMAINS: readonly string[] = ["notaires.fr", "gouv.fr"];

/** Domaine partagé auquel l'adresse (ou le domaine) appartient, ou `null` pour un domaine propre. */
export function sharedMailDomainOf(emailOrDomain: string): string | null {
  const domain = mailDomainOf(emailOrDomain);
  return (
    INFORMATION_AGENT_SHARED_MAIL_DOMAINS.find(
      (shared) => domain === shared || domain.endsWith(`.${shared}`),
    ) ?? null
  );
}

/**
 * Domaine propre à une structure : ni domaine partagé, ni messagerie grand public. Lui seul identifie un
 * cabinet ou une étude (`cabinet-dupont.fr`) ; `notaires.fr` ou `gmail.com` n'identifient personne.
 */
export function ownMailDomainOf(email: string): string | null {
  const domain = mailDomainOf(email);
  if (!domain || !domain.includes(".")) return null;
  if (sharedMailDomainOf(domain) || isConsumerMailAddress(email)) return null;
  return domain;
}

/** Code d'office notarial (CRPCEN) : chiffres seuls, 4 à 6 ; toute autre forme est ignorée. */
export function normalizedOfficeCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).trim();
  return /^\d{4,6}$/.test(digits) ? digits : null;
}

/**
 * Clés d'opposition au niveau de la structure, rangées dans la liste d'opposition par identité
 * (`information_agent_identity_oppositions`, texte libre en minuscules : aucune migration).
 *
 * - `structure|office|<crpcen>` : office notarial, quel que soit le domaine de ses adresses ;
 * - `structure|domain|<domaine>` : domaine PROPRE de la structure seulement. Jamais un domaine partagé
 *   (`notaires.fr`, `gouv.fr`) ni une messagerie grand public : une opposition y vaudrait pour toute une
 *   profession ou pour des inconnus.
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

export function isInformationAgentStructureKey(key: string): boolean {
  return key.startsWith("structure|");
}

/**
 * Unité de plafond d'envoi d'un destinataire (pilote automatique).
 *
 * - domaine propre : la structure est le domaine (`sharedDomain` nul), plafond par domaine inchangé ;
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
