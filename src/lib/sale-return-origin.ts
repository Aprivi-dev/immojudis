/**
 * Origine du « Retour » d'une fiche (`?from=/sales?…`), lue dans l'adresse puis retirée de la barre
 * d'adresse. Sans ce retrait, une adresse copiée depuis la barre et publiée ailleurs donne aux
 * robots une variante de la fiche par recherche d'origine : Google en a indexé des dizaines, en
 * préférant parfois la variante à l'adresse canonique. L'adresse affichée étant toujours la
 * canonique, le bouton « Partager » n'a plus rien à retirer.
 *
 * L'origine est rendue telle quelle : la fiche la valide à l'usage (`safeSalesReturnTo`). Elle vaut
 * pour l'affichage en cours : après un rechargement, « Retour » mène au catalogue (le bouton
 * Précédent du navigateur, lui, ramène toujours à la recherche). Court à dessein : le JavaScript
 * client total est à quelques centaines d'octets de son plafond (`check-build-budgets.mjs`).
 */
export function takeSaleReturnOrigin(): string | null {
  const url = new URL(location.href);
  const origin = url.searchParams.get("from");
  if (origin !== null) {
    url.searchParams.delete("from");
    // Intégré au routeur de Next.js (voir la documentation « single-page applications »).
    history.replaceState(null, "", url.href);
  }
  return origin;
}
