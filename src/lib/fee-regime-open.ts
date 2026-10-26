// Quels types de vente ont un régime de frais ouvert, et lequel : l'interrupteur par régime, sans
// aucun import ni texte. Module minuscule, pour que les cartes de résultats (page des favoris,
// budget de bundle serré) décident « plafond ou non » sans embarquer le vocabulaire
// (`fee-regime-labels.ts`), les barèmes (`fee-regime-definitions.ts`) ni `getSaleProcedure`.

/** Les régimes prévus : source unique de la liste des clés (ventes notariales et domaniales à venir). */
export const FEE_REGIME_KEYS = [
  "tribunal",
  "notary_auction",
  "notary_online",
  "state_auction",
] as const;
export type FeeRegimeKey = (typeof FEE_REGIME_KEYS)[number];

/**
 * Les régimes dont les règles sont définies (`FEE_REGIMES` de `fee-regime-definitions.ts` et
 * `FEE_REGIME_TERMS` de `fee-regime-labels.ts` portent les mêmes clés : un test le vérifie). Une clé
 * absente d'ici ne s'ouvre jamais.
 */
export const DEFINED_FEE_REGIMES: readonly FeeRegimeKey[] = ["tribunal"];

/** Régimes ouverts tant que rien d'autre n'est configuré : le tribunal, toujours ouvert. */
export const DEFAULT_OPEN_FEE_REGIMES: readonly FeeRegimeKey[] = ["tribunal"];

/** Le calcul du régime est ouvert : ses règles sont définies, et le tribunal l'est toujours. */
export function isFeeRegimeOpen(
  key: FeeRegimeKey,
  open: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): boolean {
  return DEFINED_FEE_REGIMES.includes(key) && (key === "tribunal" || open.includes(key));
}

/**
 * Le régime de frais d'un type de vente (`venueType` de `getSaleProcedure`) quand son calcul est
 * ouvert, sinon `null`. Aujourd'hui seule une vente au tribunal en a un ; les ventes notariales et
 * domaniales n'en auront un qu'avec leurs règles de frais. Une seule table de correspondance : les
 * fiches, les cartes de résultats et le rapport en dépendent.
 */
export function feeRegimeKeyForVenue(
  venueType: string,
  open: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): FeeRegimeKey | null {
  const key: FeeRegimeKey | null = venueType === "tribunal" ? "tribunal" : null;
  return key != null && isFeeRegimeOpen(key, open) ? key : null;
}
