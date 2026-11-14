/**
 * Titre et description propres à l'accueil (avant, il reprenait `COMPANY_DESCRIPTION`, identique à
 * celle de `/a-propos` et du layout). Le titre porte l'expression la plus cherchée de la famille
 * (« enchères immobilières », décision du propriétaire du 14/11/2026) ; `/sales` garde « ventes
 * immobilières aux enchères ». Le slogan reste le titre de la page (H1).
 *
 * Limites : titre à 60 caractères au plus, description à 155 au plus (`editorial-metadata.test.ts`).
 * Le titre cite le notaire dans tous les cas : les ventes notariales restent au catalogue même quand
 * `notaryAndStatePilotsEnabled` masque leurs filtres. La description ne cite les notaires et l'État
 * que lorsque leurs entrées sont affichées.
 */
export const HOME_TITLE = "Enchères immobilières : tribunal et notaire - Immojudis";

export function homeDescription(withNotaryAndState: boolean): string {
  return withNotaryAndState
    ? "Annonces des ventes immobilières aux enchères des tribunaux, des notaires et de l’État : points clés des pièces et plafond estimé pour mieux décider."
    : "Annonces des ventes immobilières aux enchères des tribunaux : points clés des pièces et plafond estimé pour mieux décider avant d’enchérir.";
}
