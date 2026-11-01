/**
 * Primitives statistiques communes. Module pur : aucune dépendance, aucun accès réseau ni base.
 *
 * Wilson d'abord : la règle des pépites (`pepite-policy.ts`) et les statistiques des tribunaux
 * (`tribunal-listing-statistics.ts`) en avaient chacune une copie, avec chacune sa constante. Les
 * percentiles (9 variantes dans le code) viendront ici ensuite, un par un, avec leur test de
 * caractérisation.
 */

/** Quantile de la loi normale centrée réduite à 97,5 % : intervalle de Wilson à 95 %. */
export const WILSON_Z_95 = 1.959964;

/**
 * Intervalle de Wilson à 95 % d'une part `share` (entre 0 et 1) observée sur `sample` observations,
 * borné à [0, 1], non arrondi. Il reste correct pour de petits effectifs et près de 0 ou de 1,
 * contrairement à l'intervalle normal. `null` sans effectif (`sample` inférieur ou égal à 0)
 * ou pour une part non finie ; une part hors de [0, 1] est ramenée dans cet intervalle.
 */
export function wilsonInterval95(
  share: number,
  sample: number,
): { low: number; high: number } | null {
  if (!(sample > 0) || !Number.isFinite(share)) return null;
  const p = Math.min(1, Math.max(0, share));
  const z2 = WILSON_Z_95 ** 2;
  const denominator = 1 + z2 / sample;
  const center = p + z2 / (2 * sample);
  const margin = WILSON_Z_95 * Math.sqrt((p * (1 - p)) / sample + z2 / (4 * sample ** 2));
  return {
    low: Math.max(0, (center - margin) / denominator),
    high: Math.min(1, (center + margin) / denominator),
  };
}
