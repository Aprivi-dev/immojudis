import {
  PEPITE_CHANCE_EXIT_SHARE,
  PEPITE_CHANCE_MIN_SHARE,
  PEPITE_COST_EXIT_SHARE_COURT,
  PEPITE_COST_EXIT_SHARE_NOTARY,
  PEPITE_COST_MAX_SHARE_COURT,
  PEPITE_COST_MAX_SHARE_NOTARY,
  PEPITE_COURT_COMPLETE_BELOW_SALES,
  PEPITE_COURT_REPLACE_BELOW_SALES,
  PEPITE_EXTREME_START_RATIO_MAX,
  PEPITE_EXTREME_START_RATIO_MIN,
  PEPITE_FAVOURABLE_EVALUATIONS,
  PEPITE_FREEZE_DAYS,
  PEPITE_HISTORY_YEARS,
  PEPITE_LOW_STARTING_PRICE_SHARE,
  PEPITE_MAX_EVALUATION_AGE_HOURS,
  PEPITE_MIN_VALUE_COMPARABLES,
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_V1_RULE_VERSION,
} from "@/lib/pepite-policy";

/**
 * Adresse et seuils publiés sur « Comment repérons-nous les pépites ? ».
 *
 * Les seuils sont ceux de la règle `pepite-v1`, validée par le fondateur le 26/10/2026 (compte-rendu
 * `docs/equipe/2026-10-26-plafond-tous-types-et-selection.md`), repris tels quels par `pepite-v2`, qui n'ajoute
 * que le critère éliminatoire du risque d'inondation (aucun seuil chiffré : un verdict). Ils viennent des
 * constantes de la règle (`src/lib/pepite-policy.ts`), le module pur qui sert aussi au calcul : la page ne peut
 * donc pas annoncer un seuil que le calcul n'applique pas. Quand la règle change (nouvelle version), cette
 * page change avec elle, et le test de la page (`page.test.tsx`) doit être mis à jour dans le même
 * geste. Le module de la règle ne lit ni la base ni le catalogue : la page non plus.
 */
export { PEPITE_METHOD_PATH } from "@/lib/pepite-copy";

export { PEPITE_LATEST_RULE_VERSION, PEPITE_V1_RULE_VERSION };

/**
 * Date d'entrée en vigueur de la règle `pepite-v2`, écrite en toutes lettres (« 27 novembre 2026 »), À RENSEIGNER
 * À LA BASCULE (voir `docs/operations/planification.md`, « Règle pepite-v2 »), en même temps que l'ouverture de
 * l'interrupteur `PEPITE_RULE_V2_ENABLED`. Tant qu'elle est `null`, la page qui décrit la v2 (interrupteur ouvert)
 * n'écrit pas de date : jamais d'espace réservé visible du public.
 */
export const PEPITE_V2_EFFECTIVE_DATE: string | null = null;

/** « (en vigueur le 27 novembre 2026) » ou rien quand la date n'est pas encore renseignée. */
export function pepiteV2EffectiveClause(date: string | null = PEPITE_V2_EFFECTIVE_DATE): string {
  return date ? ` (en vigueur le ${date})` : "";
}

/** Une part (0 à 1) de la règle, en pourcentage entier pour la page. */
const percent = (share: number) => Math.round(share * 100);

/**
 * Seuils de la règle, communs à `pepite-v1` et `pepite-v2` (la v2 n'en change aucun). Le nom ne porte plus la
 * version : un seuil qui changerait créerait une nouvelle version de règle, et cette table suivrait la règle
 * courante.
 */
export const PEPITE_RULE_PARAMS = {
  /** Test B (tribunal) : part minimale des ventes comparables adjugées sous l'enchère plafond, en %. */
  chanceMinPct: percent(PEPITE_CHANCE_MIN_SHARE),
  /** Test C (tribunal) : coût total probable au plus égal à cette part de la valeur centrale, en %. */
  maxCostShareCourtPct: percent(PEPITE_COST_MAX_SHARE_COURT),
  /** Test C (ventes notariales) : même rapport, seuil plus strict, en %. */
  maxCostShareNotaryPct: percent(PEPITE_COST_MAX_SHARE_NOTARY),
  /** Sortie : le test B redescend sous ce seuil, en %. */
  exitChanceBelowPct: percent(PEPITE_CHANCE_EXIT_SHARE),
  /** Sortie au tribunal : le test C dépasse ce seuil, en %. */
  exitCostShareAbovePct: percent(PEPITE_COST_EXIT_SHARE_COURT),
  /** Sortie en vente notariale : le test C dépasse ce seuil, en %. */
  exitCostShareNotaryAbovePct: percent(PEPITE_COST_EXIT_SHARE_NOTARY),
  /** Mise à prix sous cette part de la valeur estimée : écartée (erreur de données probable), en %. */
  extremeStartingPriceBelowPct: percent(PEPITE_EXTREME_START_RATIO_MIN),
  /** Mise à prix au-dessus de cette part de la valeur estimée : écartée, en %. */
  extremeStartingPriceAbovePct: percent(PEPITE_EXTREME_START_RATIO_MAX),
  /** Nombre d'évaluations favorables consécutives avant l'apparition. */
  favourableEvaluations: PEPITE_FAVOURABLE_EVALUATIONS,
  /** Le repère est figé ce nombre de jours avant la vente. */
  freezeDaysBeforeSale: PEPITE_FREEZE_DAYS,
  /** Nombre minimal de ventes comparables de l'estimation de valeur. */
  minValueComparables: PEPITE_MIN_VALUE_COMPARABLES,
  /** Historique des ventes comparables, en années. */
  historyYears: PEPITE_HISTORY_YEARS,
  /** Sous ce nombre de ventes du tribunal, on complète par le taux national. */
  courtCompleteBelowSales: PEPITE_COURT_COMPLETE_BELOW_SALES,
  /** Sous ce nombre de ventes du tribunal, on le remplace par le taux national. */
  courtReplaceBelowSales: PEPITE_COURT_REPLACE_BELOW_SALES,
  /** Mise à prix inférieure à cette part de la valeur estimée : on retient les trois quarts des ventes. */
  lowStartingPricePct: percent(PEPITE_LOW_STARTING_PRICE_SHARE),
  /** Âge maximal de l'évaluation affichée, en heures. */
  maxEvaluationAgeHours: PEPITE_MAX_EVALUATION_AGE_HOURS,
} as const;
