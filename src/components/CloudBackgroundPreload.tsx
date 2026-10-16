import { preload } from "react-dom";

/** Fond de `.liquid-page` (src/styles.css). Garder les deux adresses identiques. */
export const CLOUD_BACKGROUND_SRC = "/media/landing/cloud-background.webp";

/**
 * Précharge l'image de fond des pages `.liquid-page`. Ce fond n'est déclaré qu'en CSS : sans
 * indice, le navigateur ne le découvre qu'après le téléchargement et l'analyse de la feuille de
 * style, et il devient l'élément le plus grand affiché (LCP) bien après le texte.
 *
 * À placer dans les seules pages qui affichent `.liquid-page` au premier écran (pas dans le
 * layout racine : l'accueil `.ij-page` a pour LCP la photo du dossier d'exemple, à laquelle ce
 * téléchargement ferait concurrence). Ne rend rien ; React insère le `<link rel="preload">` dans
 * le `<head>` (pages statiques comprises).
 */
export function CloudBackgroundPreload() {
  preload(CLOUD_BACKGROUND_SRC, { as: "image", fetchPriority: "high", type: "image/webp" });
  return null;
}
