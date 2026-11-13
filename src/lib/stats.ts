/**
 * Primitives statistiques communes. Module pur : aucune dépendance, aucun accès réseau ni base.
 *
 * L'intervalle de Wilson (la règle des pépites et les statistiques des tribunaux en avaient chacune
 * une copie, avec chacune sa constante), puis les quantiles et la médiane (une dizaine de copies).
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

/**
 * Quantile `p` (entre 0 et 1) d'une liste déjà triée par ordre croissant, par interpolation linéaire
 * entre les deux rangs voisins (type 7 de Hyndman et Fan, celui de R et de NumPy par défaut).
 * `null` pour une liste vide.
 */
export function quantileSorted(sortedAsc: readonly number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const position = (sortedAsc.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (position - lower);
}

function finiteSorted(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
}

/**
 * Quantile `p` d'une liste dans un ordre quelconque (voir `quantileSorted`), sans ses valeurs non
 * finies ; `null` s'il n'en reste aucune.
 */
export function quantile(values: readonly number[], p: number): number | null {
  return quantileSorted(finiteSorted(values), p);
}

/**
 * Médiane, sans les valeurs non finies : la valeur centrale, ou la moyenne des deux valeurs
 * centrales pour un compte pair ; `null` s'il ne reste aucune valeur.
 */
export function median(values: readonly number[]): number | null {
  const sorted = finiteSorted(values);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
