/**
 * Contraste élevé (couleurs forcées de Windows) : un bouton choisi (`aria-pressed`) se remplit de la
 * couleur de sélection du système (`Highlight`), texte en `HighlightText`. Les fonds de couleur
 * disparaissent dans ce mode : la pastille pleine marine devenait une pastille comme les autres, à
 * peine plus marquée par le liseré commun de `src/styles.css`. Pour les pastilles de type de vente,
 * les filtres rapides du mobile et la bascule « Cartes / Tableau » de /sales. La règle est dans
 * `src/styles.css` (bloc `forced-colors: active`) : une seule classe courte plutôt que quatre classes
 * Tailwind recopiées dans le JavaScript de chaque composant.
 */
export const FORCED_COLORS_SELECTED = "forced-selected";
