/**
 * Titre et description propres à l'accueil (avant, il reprenait `COMPANY_DESCRIPTION`, identique à
 * celle de `/a-propos` et du layout). Le titre porte l'expression que les visiteurs cherchent
 * (« ventes immobilières aux enchères judiciaires ») ; le slogan reste le titre de la page (H1).
 *
 * Limites : titre à 60 caractères au plus, description à 155 au plus (`editorial-metadata.test.ts`).
 * Les notaires et l'État ne sont cités que lorsque ces ventes sont au catalogue
 * (`notaryAndStatePilotsEnabled`).
 */
export const HOME_TITLE = "Ventes immobilières aux enchères judiciaires - Immojudis";

export function homeDescription(withNotaryAndState: boolean): string {
  return withNotaryAndState
    ? "Annonces des ventes immobilières aux enchères des tribunaux, des notaires et de l’État : points clés des pièces et plafond estimé pour mieux décider."
    : "Annonces des ventes immobilières aux enchères des tribunaux : points clés des pièces et plafond estimé pour mieux décider avant d’enchérir.";
}
