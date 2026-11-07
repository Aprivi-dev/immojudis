/**
 * Parcours d'accès à l'espace professionnel (repasse design n° 18). Module sans dépendance : il est
 * lu par `AuthGate`, présent sur de nombreuses pages.
 */

/**
 * Demande d'accès professionnel d'un compte DÉJÀ connecté (`/espace-pro`, `/publish`) : le
 * formulaire de contact, sujet « Espace professionnel ». `/login?mode=professional` renvoie aussitôt
 * un compte connecté vers sa destination : c'était une boucle de connexion.
 */
export const PROFESSIONAL_ACCESS_REQUEST_HREF = "/contact?sujet=professionnel";

/** Espace où un compte professionnel suit ses demandes, y compris pendant sa validation. */
export const PROFESSIONAL_WORKSPACE_HREF = "/espace-pro";
