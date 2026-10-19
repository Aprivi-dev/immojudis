/** Messages de la route (`previewSearchLimitViolation`) pour une page ou une taille hors bornes. */
const OUT_OF_RANGE_ROUTE_MESSAGES = new Set(["Page hors limites.", "Taille de page invalide."]);

/** Phrase montrée quand la page demandée n'existe pas pour cette recherche (lien ancien, saisie). */
export const OUT_OF_RANGE_MESSAGE =
  "Cette page n’existe pas pour cette recherche. Revenez à la première page.";

/**
 * Recherche refusée par la route (400) : la demande est en cause, pas le catalogue. Ce n'est pas une
 * panne : on ne la rejoue pas (même réponse) et on ne la présente pas comme « le catalogue ne
 * répond pas ». `outOfRange` : page ou taille de page hors bornes (adresse ancienne ou saisie à la
 * main), à qui l'on propose de revenir à la page 1.
 */
export class SearchRejectedError extends Error {
  readonly status = 400;
  readonly outOfRange: boolean;

  constructor(routeMessage: string) {
    const outOfRange = OUT_OF_RANGE_ROUTE_MESSAGES.has(routeMessage);
    super(outOfRange ? OUT_OF_RANGE_MESSAGE : routeMessage || "Cette recherche n’est pas valide.");
    this.name = "SearchRejectedError";
    this.outOfRange = outOfRange;
  }
}

export function isOutOfRangeSearchError(error: unknown): boolean {
  return error instanceof SearchRejectedError && error.outOfRange;
}

/**
 * Règle de relance des recherches (`retry` de React Query) : une panne est retentée une fois, une
 * demande refusée (400) jamais.
 */
export function retrySearch(failureCount: number, error: unknown): boolean {
  return !(error instanceof SearchRejectedError) && failureCount < 1;
}
