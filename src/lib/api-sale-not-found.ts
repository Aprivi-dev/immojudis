import { PublicApiError } from "@/lib/api-errors";

/** Message of `SalePublicationUnavailableError` and of `getSale` for a sale that is not visible. */
export const SALE_NOT_FOUND_MESSAGE = "Vente introuvable ou inaccessible.";

const SALE_NOT_FOUND_ERROR_NAMES = new Set([
  "SalePublicationUnavailableError",
  "TribunalJudicialSaleNotFoundError",
]);

/**
 * Une vente inconnue (ou retirée de la publication) est une réponse 404 : sans cette
 * conversion, les routes `/api/v1` qui n'exposent pas les messages métier la rendaient en 503
 * (« service indisponible »), ce qui poussait un client à réessayer pour rien. Toute autre erreur
 * est renvoyée telle quelle. Reconnaissance par nom et par message : ce module n'importe aucun
 * code serveur, donc les routes qui le chargent n'héritent d'aucune dépendance.
 */
export function saleNotFoundAsPublicError(error: unknown): unknown {
  if (
    error instanceof Error &&
    (SALE_NOT_FOUND_ERROR_NAMES.has(error.name) || error.message === SALE_NOT_FOUND_MESSAGE)
  ) {
    return new PublicApiError(SALE_NOT_FOUND_MESSAGE, 404);
  }
  return error;
}
