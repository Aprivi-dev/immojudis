/**
 * Effectifs minimaux de ventes comparables, définis une seule fois pour le moteur d'estimation
 * (`market-estimation-engine.ts`, `market.server.ts`) et pour la porte publique de la bande d'écart
 * au marché (`market-gap-band.ts`, miroir de la migration 20261029120000).
 *
 * Avant ce module, le moteur arrêtait l'élargissement du rayon dès 4 comparables
 * (`MIN_ACTIONABLE_SAMPLE`) alors que la porte publique en exige 6 (intervalle jackknife) ou 8 : une
 * estimation à 4 ou 5 comparables ne pouvait jamais franchir la porte, quel que soit le rayon
 * que le moteur aurait pu essayer ensuite.
 */

/** Nombre minimal de résidus (donc de comparables) pour que l'intervalle soit « local_jackknife ». */
export const MARKET_JACKKNIFE_MIN_COMPARABLES = 6;

/** Sans jackknife (marge fixe du type de bien ou intervalle du modèle) : la porte en exige davantage. */
export const MARKET_NON_JACKKNIFE_MIN_COMPARABLES = 8;

/**
 * Effectif à atteindre avant d'arrêter l'élargissement du rayon. Un effectif de 6 donne toujours un
 * intervalle jackknife (chaque comparable a alors 5 voisins, au-dessus du minimum de 3 du calcul des
 * résidus), donc franchit la porte sur ce critère ; 4 ou 5 comparables ne le peuvent jamais.
 */
export const MARKET_WIDEN_UNTIL_COMPARABLES = MARKET_JACKKNIFE_MIN_COMPARABLES;

/**
 * Couverture minimale, en % des ventes de validation, de l'intervalle d'un modèle statistique pour
 * qu'il soit mis en service (niveau nominal : 80 %). Recopiée de `MIN_PROMOTION_COVERAGE_PCT`
 * (services/data-pipeline/src/valuation_activation_gate.py) ; `market-comparable-minimums.test.ts` relit
 * le source Python pour que les deux ne divergent pas. Citée par la page méthode, et appliquée au
 * service : un modèle actif dont la couverture mesurée par la porte manque ou reste sous ce plancher
 * n'est pas utilisé (`hybrid-market-valuation.ts`, D2 du 14/11).
 */
export const VALUATION_MODEL_MIN_COVERAGE_PCT = 70;
