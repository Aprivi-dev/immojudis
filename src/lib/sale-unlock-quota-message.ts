/**
 * Phrase du quota de déblocages atteint : la réponse 409 de `POST /api/sales/[id]/unlock` et
 * l'erreur qu'en tire le client. Module à part plutôt que dans `sale-unlocks.ts` : ce dernier est
 * chargé par des pages qui ne débloquent rien (l'annonce d'exemple), qui recevraient la phrase.
 */
export const SALE_UNLOCK_QUOTA_MESSAGE = "Vous avez utilisé tous vos déblocages de ce mois-ci.";
