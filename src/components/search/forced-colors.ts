/**
 * Contraste élevé (couleurs forcées de Windows) : un bouton choisi (`aria-pressed`) se remplit de la
 * couleur de sélection du système (`Highlight`), texte en `HighlightText`. Les fonds de couleur
 * disparaissent dans ce mode : la pastille pleine marine devenait une pastille comme les autres, à
 * peine plus marquée par le liseré commun de `src/styles.css`. Pour les pastilles de type de vente,
 * les filtres rapides du mobile et la bascule « Cartes / Tableau » de /sales.
 */
export const FORCED_COLORS_SELECTED =
  "forced-colors:forced-color-adjust-none forced-colors:border-[color:Highlight] forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText]";
