import type { RentReference } from "@/lib/rent-reference";

// Mentions de la carte des loyers de l'ANIL (Licence Ouverte 2.0), texte long compris. Le navigateur ne
// charge ce module que par `RentSourceNotice` (à la demande) : les écrans qui n'affichent pas la mention
// n'en embarquent aucune copie (budget de JavaScript client, voir `check-build-budgets.mjs`).

/** Mention obligatoire de la Licence Ouverte 2.0 de la carte des loyers, à reproduire à l'identique. */
export const RENT_ATTRIBUTION =
  "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.";
/** Page de la source : le lien est obligatoire là où un loyer ou un rendement ANIL s'affiche. */
export const RENT_SOURCE_URL = "https://www.data.gouv.fr/datasets/693aa2feed1bf4da603faa49";
/**
 * Édition de la carte des loyers importée, pour les mentions qui ne portent pas sur une vente
 * (filtre, alertes). À mettre à jour à chaque nouvel import (`vintage` et `source_updated_on` de
 * `anil_rents`) ; les écrans qui portent sur une vente affichent, eux, ceux de la ligne utilisée.
 */
export const ANIL_CURRENT_EDITION = { vintage: 2025, sourceUpdatedOn: "2025-12-11" } as const;

export function isAnilRentReference(
  reference: RentReference | null | undefined,
): reference is RentReference {
  return reference?.source.startsWith("anil_") === true;
}

/** « 11 décembre 2025 » à partir d'une date ISO, ou `null`. */
export function formatRentSourceDate(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Complément de la mention de source, avec le millésime et la date de mise à jour de la donnée
 * réellement utilisée. `null` hors données ANIL.
 */
export function rentSourceDetail(
  reference: Pick<RentReference, "source" | "vintage" | "sourceUpdatedOn"> | null | undefined,
): string | null {
  if (!reference || !reference.source.startsWith("anil_")) return null;
  const updated = formatRentSourceDate(reference.sourceUpdatedOn);
  return (
    `Carte des loyers${reference.vintage ? ` ${reference.vintage}` : ""} (loyers d’annonce, charges comprises, indicateurs expérimentaux, logements non meublés)` +
    `${updated ? `, mise à jour du ${updated}` : ""}, Licence Ouverte 2.0. ` +
    "Rendement calculé par Immojudis, sous sa seule responsabilité : ni l’ANIL, ni SeLoger, ni leboncoin n’en sont responsables."
  );
}

/** Mention de source complète (crédit puis complément), ou `null` hors données ANIL. */
export function rentSourceNotice(
  reference: Pick<RentReference, "source" | "vintage" | "sourceUpdatedOn"> | null | undefined,
): string | null {
  const detail = rentSourceDetail(reference);
  return detail ? `${RENT_ATTRIBUTION} ${detail}` : null;
}
