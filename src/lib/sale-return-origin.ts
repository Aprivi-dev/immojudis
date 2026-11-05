import { safeSalesReturnTo } from "@/lib/navigation";

const STORAGE_PREFIX = "immojudis:sale-return:";

/**
 * Origine du « Retour » d'une fiche (`?from=/sales?…`), lue dans l'adresse puis retirée de la barre
 * d'adresse. Sans ce retrait, une adresse copiée depuis la barre et publiée ailleurs donne aux
 * robots une variante de la fiche par recherche d'origine : Google en a indexé des dizaines, en
 * préférant parfois la variante à l'adresse canonique. Le bouton « Partager » retirait déjà
 * l'origine (`SaleListing`) ; la barre d'adresse le fait désormais aussi.
 *
 * L'origine reste connue de l'onglet (`sessionStorage`) : un rechargement de la fiche garde son
 * « Retour ». Seule une origine valide (`safeSalesReturnTo`) est gardée. Le stockage peut manquer
 * (navigation privée, stockage bloqué) : l'origine vaut alors pour l'affichage en cours seulement.
 */
export function takeSaleReturnOrigin(saleId: string): string | null {
  const key = `${STORAGE_PREFIX}${saleId}`;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("from");
  if (fromUrl === null) {
    try {
      return safeSalesReturnTo(window.sessionStorage.getItem(key)) ?? null;
    } catch {
      return null;
    }
  }

  const origin = safeSalesReturnTo(fromUrl) ?? null;
  try {
    if (origin) window.sessionStorage.setItem(key, origin);
  } catch {
    // Stockage indisponible : l'origine sert seulement à l'affichage en cours.
  }
  params.delete("from");
  const query = params.toString();
  // Intégré au routeur de Next.js (voir la documentation « single-page applications »).
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
  return origin;
}
