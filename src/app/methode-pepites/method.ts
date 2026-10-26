/**
 * Adresse et seuils publiés sur « Comment repérons-nous les pépites ? ».
 *
 * Les seuils sont ceux de la règle `pepite-v1`, validée par le fondateur le 26/10/2026 (compte-rendu
 * `docs/equipe/2026-10-26-plafond-tous-types-et-selection.md`). Ils sont recopiés ici à la main :
 * quand la règle de calcul change (nouvelle version), cette page change avec elle, et le test de la
 * page (`page.test.tsx`) doit être mis à jour dans le même geste. Ce fichier ne dépend d'aucun
 * module de calcul : la page ne lit donc ni la base ni le catalogue.
 */
export const PEPITE_METHOD_PATH = "/methode-pepites";

export const PEPITE_RULE_VERSION = "pepite-v1";

export const PEPITE_V1 = {
  /** Test B (tribunal) : part minimale des ventes comparables adjugées sous l'enchère plafond, en %. */
  chanceMinPct: 70,
  /** Test C (tribunal) : coût total probable au plus égal à cette part de la valeur centrale, en %. */
  maxCostShareCourtPct: 75,
  /** Test C (ventes notariales) : même rapport, seuil plus strict, en %. */
  maxCostShareNotaryPct: 65,
  /** Sortie : le test B redescend sous ce seuil, en %. */
  exitChanceBelowPct: 65,
  /** Sortie : le test C dépasse ce seuil, en %. */
  exitCostShareAbovePct: 80,
  /** Nombre d'évaluations favorables consécutives avant l'apparition. */
  favourableEvaluations: 2,
  /** Le repère est figé ce nombre de jours avant la vente. */
  freezeDaysBeforeSale: 7,
  /** Nombre minimal de ventes comparables de l'estimation de valeur. */
  minValueComparables: 8,
  /** Historique des ventes comparables, en années. */
  historyYears: 3,
  /** Sous ce nombre de ventes du tribunal, on complète par le taux national. */
  courtCompleteBelowSales: 30,
  /** Sous ce nombre de ventes du tribunal, on le remplace par le taux national. */
  courtReplaceBelowSales: 10,
  /** Mise à prix inférieure à cette part de la valeur estimée : on retient les trois quarts des ventes. */
  lowStartingPricePct: 30,
  /** Âge maximal de l'évaluation affichée, en heures. */
  maxEvaluationAgeHours: 36,
} as const;
