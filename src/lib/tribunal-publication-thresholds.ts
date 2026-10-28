/**
 * Seuils de publication des statistiques d'un tribunal, définis une seule fois (module sans
 * dépendance : le navigateur peut l'importer sans charger les schémas de validation).
 *
 * - sous `TRIBUNAL_STATISTICS_RANGE_MIN_SAMPLE` observations : aucun chiffre, seulement « n ventes » ;
 * - de `RANGE_MIN_SAMPLE` à `MEDIAN_MIN_SAMPLE - 1` : la fourchette observée (minimum et maximum),
 *   jamais un point ;
 * - à partir de `TRIBUNAL_STATISTICS_MEDIAN_MIN_SAMPLE` : la médiane. À 5 observations, un taux de
 *   60 % peut aussi bien être 23 % que 88 % (intervalle de Wilson à 95 %).
 *
 * La fiche d'une vente (`tribunal-listing-statistics.ts`), la liste `/tribunaux`, la page d'un
 * tribunal (`public-tribunal-activity.ts`) et l'explorateur Analyse
 * (`tribunal-judicial-activity.ts`) lisent ces constantes. La migration
 * `20261108160000_public_tribunal_price_figures.sql` recopie les deux nombres dans la base :
 * les changer ici demande de changer la fonction aussi.
 */
export const TRIBUNAL_STATISTICS_RANGE_MIN_SAMPLE = 5;
export const TRIBUNAL_STATISTICS_MEDIAN_MIN_SAMPLE = 10;
