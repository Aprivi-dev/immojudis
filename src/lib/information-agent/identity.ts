import { normalizeLawyerIdentity, resolveCnbDatasetBarKey } from "@/lib/lawyer-bar";

/**
 * Clé d'identité d'un professionnel contacté par l'agent d'information.
 *
 * L'opposition est indexée sur l'adresse (`normalized_email`), donc un professionnel opposé
 * réapparaîtrait sous une autre adresse (annuaire, site du cabinet). La clé d'identité normalisée
 * (rôle + nom + barreau ou ville, ou SIREN) permet de le reconnaître. Elle est vérifiée avant toute
 * recherche d'adresse et avant l'envoi.
 *
 * Une clé est un texte ASCII sans casse : `lawyer|paris|dupont jean`, `notary|bordeaux|martin`,
 * `siren|123456789`. Elle ne contient aucune adresse email.
 */

export const INFORMATION_AGENT_IDENTITY_ROLES = [
  "lawyer",
  "notary",
  "commissaire_de_justice",
  "manager",
] as const;

export type InformationAgentIdentityRole = (typeof INFORMATION_AGENT_IDENTITY_ROLES)[number];

export type InformationAgentIdentity = {
  /**
   * Rôle connu du professionnel. Un rôle absent ou imprécis (contact de la source, organisateur,
   * saisie manuelle) est étendu à tous les rôles : mieux vaut un blocage de trop qu'un contact
   * d'une personne opposée.
   */
  role?: string | null;
  name?: string | null;
  /** Barreau (avocat) : libellé du barreau ou du tribunal judiciaire. */
  bar?: string | null;
  city?: string | null;
  /** SIREN (9 chiffres) ou SIRET (14 chiffres) du cabinet ou de l'étude, quand il est connu. */
  siren?: string | null;
};

/**
 * Barreaux de l'Île-de-France où un avocat peut postuler (multipostulation) : le même avocat peut
 * apparaître sous l'un ou l'autre selon le tribunal de la vente (Paris, Bobigny, Créteil, Nanterre).
 * Leurs clés sont émises ensemble ; ce sont les clés du jeu de données du CNB.
 */
const MULTIPOSTULATION_BARS = [
  "paris",
  "seine saint denis",
  "val de marne",
  "hauts de seine",
] as const;

const MIN_NAME_LENGTH = 3;

function roleForKey(role: string | null | undefined): InformationAgentIdentityRole[] {
  switch (role) {
    case "lawyer":
    case "source_lawyer":
      return ["lawyer"];
    case "notary":
      return ["notary"];
    case "commissaire_de_justice":
      return ["commissaire_de_justice"];
    case "manager":
      return ["manager"];
    default:
      return [...INFORMATION_AGENT_IDENTITY_ROLES];
  }
}

/** Nom sans titre ni forme sociale, accents ôtés, mots triés : « Me Jean DUPONT » = « Dupont Jean ». */
export function normalizeInformationAgentIdentityName(value: string | null | undefined): string {
  const tokens = normalizeLawyerIdentity(value)
    .split(" ")
    .filter((token) => token.length > 0);
  return [...new Set(tokens)].sort().join(" ");
}

function normalizePlace(value: string | null | undefined): string | null {
  const key = resolveCnbDatasetBarKey(value);
  return key ? key : null;
}

function placesFor(identity: InformationAgentIdentity): string[] {
  // Le barreau prime ; la ville ne sert qu'à défaut (notaire, gestionnaire, tribunal inconnu).
  const place = normalizePlace(identity.bar) ?? normalizePlace(identity.city);
  const places = place ? [place] : [];
  const expanded = new Set<string>();
  for (const place of places) {
    if ((MULTIPOSTULATION_BARS as readonly string[]).includes(place)) {
      for (const bar of MULTIPOSTULATION_BARS) expanded.add(bar);
    } else {
      expanded.add(place);
    }
  }
  return [...expanded];
}

function normalizedSiren(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 9 || digits.length === 14) return digits.slice(0, 9);
  return null;
}

/**
 * Toutes les clés sous lesquelles ce professionnel doit être reconnu (vide si l'identité est
 * insuffisante : sans nom exploitable ni SIREN, seule l'opposition par adresse s'applique).
 */
export function informationAgentIdentityKeys(identity: InformationAgentIdentity): string[] {
  const keys = new Set<string>();
  const siren = normalizedSiren(identity.siren);
  if (siren) keys.add(`siren|${siren}`);

  const name = normalizeInformationAgentIdentityName(identity.name);
  if (name.length >= MIN_NAME_LENGTH) {
    const places = placesFor(identity);
    for (const role of roleForKey(identity.role)) {
      for (const place of places) keys.add(`${role}|${place}|${name}`);
    }
  }
  return [...keys].sort();
}

/** Les clés de plusieurs identités, sans doublon. */
export function informationAgentIdentityKeySet(
  identities: readonly InformationAgentIdentity[],
): string[] {
  return [...new Set(identities.flatMap(informationAgentIdentityKeys))].sort();
}
