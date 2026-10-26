// Quels types de vente ont un régime de frais ouvert, et lequel : l'interrupteur par régime, sans
// aucun import ni texte. Module minuscule, pour que les cartes de résultats (page des favoris,
// budget de bundle serré) décident « plafond ou non » sans embarquer le vocabulaire
// (`fee-regime-labels.ts`), les barèmes (`fee-regime-definitions.ts`) ni `getSaleProcedure`.

/** Les régimes prévus : source unique de la liste des clés (ventes notariales et domaniales). */
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
 * absente d'ici ne s'ouvre jamais : les ventes domaniales (`state_auction`) n'ont pas de régime.
 */
export const DEFINED_FEE_REGIMES: readonly FeeRegimeKey[] = [
  "tribunal",
  "notary_auction",
  "notary_online",
];

/**
 * Régimes ouverts tant que `CEILING_FEE_REGIMES_OPEN` n'est pas renseignée : tous ceux dont les
 * règles sont définies. Renseignée, la variable ne laisse ouverts que les régimes qu'elle liste
 * (voir `parseOpenFeeRegimes`) ; le tribunal l'est toujours.
 */
export const DEFAULT_OPEN_FEE_REGIMES: readonly FeeRegimeKey[] = DEFINED_FEE_REGIMES;

/** Le calcul du régime est ouvert : ses règles sont définies, et le tribunal l'est toujours. */
export function isFeeRegimeOpen(
  key: FeeRegimeKey,
  open: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): boolean {
  return DEFINED_FEE_REGIMES.includes(key) && (key === "tribunal" || open.includes(key));
}

/**
 * Les régimes de frais que peut avoir un type de vente (`venueType` de `getSaleProcedure`), parmi
 * ceux dont le calcul est ouvert : le tribunal pour une vente au tribunal, la bougie et la vente
 * interactive pour une vente notariale, rien pour les autres types (ventes domaniales comprises).
 * Une vente notariale n'a qu'un seul de ces deux régimes, que seules les conditions de la vente
 * départagent (`feeRegimeForSale`) : tant qu'elles sont inconnues (compte Découverte qui n'a pas
 * débloqué la vente, cartes de résultats), les deux sont possibles. Une seule table de
 * correspondance : les fiches, les cartes de résultats et le rapport en dépendent.
 */
export function feeRegimeKeysForVenue(
  venueType: string,
  open: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): FeeRegimeKey[] {
  const candidates: FeeRegimeKey[] =
    venueType === "tribunal"
      ? ["tribunal"]
      : venueType === "notary"
        ? ["notary_auction", "notary_online"]
        : [];
  return candidates.filter((key) => isFeeRegimeOpen(key, open));
}
