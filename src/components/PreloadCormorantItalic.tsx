"use client";

import { preload } from "react-dom";
import cormorantItalicUrl from "@/fonts/cormorant-garamond-latin-italic.woff2";

/**
 * Précharge l'italique de Cormorant Garamond sur les pages qui l'affichent au premier écran
 * (accueil et /ressources : accent du h1). Le fichier est le même que celui de la règle
 * `@font-face` de `src/styles.css` (une seule URL, une seule copie dans `_next/static/media`).
 *
 * Composant client EXPRÈS. Un `preload()` appelé dans un composant serveur est écrit dans le flux
 * RSC comme un indice : toute page qui préfetche celle-ci (le menu de `/sales` préfetche `/` et
 * `/ressources`) l'exécuterait et ajouterait au `<head>` un préchargement d'italique que sa page
 * n'utilise pas (avertissement « preloaded but not used », 39 Ko pour rien). Un composant client
 * ne s'exécute pas pour un préfetch : l'indice est écrit dans le HTML de la page elle-même au rendu
 * serveur, et à la navigation vers elle.
 */
export function PreloadCormorantItalic() {
  preload(cormorantItalicUrl, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return null;
}
