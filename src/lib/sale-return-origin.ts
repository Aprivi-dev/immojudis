/**
 * Origine du « Retour » d'une fiche (`?from=/sales?…`), lue dans l'adresse puis retirée de la barre
 * d'adresse. Sans ce retrait, une adresse copiée depuis la barre et publiée ailleurs donne aux
 * robots une variante de la fiche par recherche d'origine : Google en a indexé des dizaines, en
 * préférant parfois la variante à l'adresse canonique. Le bouton « Partager » retirait déjà
 * l'origine (`SaleListing`) ; la barre d'adresse le fait désormais aussi.
 *
 * L'origine reste connue de l'onglet (`sessionStorage`) : un rechargement de la fiche garde son
 * « Retour ». Elle est rendue telle quelle : la fiche la valide à l'usage (`safeSalesReturnTo`). Le
 * stockage peut manquer (navigation privée, stockage bloqué) : l'origine vaut alors pour l'affichage
 * en cours seulement. Court à dessein : ce code compte dans le budget JavaScript de la fiche.
 */
export function takeSaleReturnOrigin(saleId: string): string | null {
  const key = `sale-return:${saleId}`;
  const url = new URL(window.location.href);
  const origin = url.searchParams.get("from");
  try {
    if (origin === null) return sessionStorage.getItem(key);
    sessionStorage.setItem(key, origin);
  } catch {
    if (origin === null) return null;
  }
  url.searchParams.delete("from");
  // Intégré au routeur de Next.js (voir la documentation « single-page applications »).
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  return origin;
}
