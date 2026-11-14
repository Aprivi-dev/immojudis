/**
 * Messages d'une requête qui n'aboutit pas : levés par `apiFetch` (`client-api-core.ts`), repris
 * par `userMessage` (`user-messages.ts`). Module sans dépendance : il entre dans le JavaScript des
 * pages publiques, qui ne doivent pas embarquer les tables de `user-messages.ts`.
 */

/** Requête qui n'a pas pu partir ou revenir (réseau coupé). */
export const NETWORK_ERROR_MESSAGE = "Connexion impossible. Vérifiez votre réseau puis réessayez.";

/** Délai de la requête dépassé : la réponse n'est pas arrivée à temps. */
export const TIMEOUT_ERROR_MESSAGE =
  "Le serveur met trop de temps à répondre. Réessayez dans un instant.";
