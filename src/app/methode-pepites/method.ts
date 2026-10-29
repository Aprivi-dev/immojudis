import {
  PEPITE_CHANCE_EXIT_SHARE,
  PEPITE_CHANCE_MIN_SHARE,
  PEPITE_CHANCE_MIN_WILSON_LOW,
  PEPITE_COST_EXIT_SHARE_COURT,
  PEPITE_COST_EXIT_SHARE_NOTARY,
  PEPITE_COST_MAX_SHARE_COURT,
  PEPITE_COST_MAX_SHARE_NOTARY,
  PEPITE_EXTREME_START_RATIO_MAX,
  PEPITE_EXTREME_START_RATIO_MIN,
  PEPITE_FAVOURABLE_EVALUATIONS,
  PEPITE_FREEZE_DAYS,
  PEPITE_HISTORY_YEARS,
  PEPITE_DPE_MIN_CONFIDENCE,
  PEPITE_ENERGY_RENOVATION_EUR_PER_M2,
  PEPITE_LOW_STARTING_PRICE_SHARE,
  PEPITE_MARKET_MAX_DECLINE_SHARE,
  PEPITE_MARKET_MIN_SALES_12_MONTHS,
  PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR,
  PEPITE_MARKET_TREND_YEARS,
  PEPITE_MARKET_WINDOW_MONTHS,
  PEPITE_MAX_CENTRAL_VALUE_EUR,
  PEPITE_MAX_EVALUATION_AGE_HOURS,
  PEPITE_MAX_HABITABLE_SURFACE_M2,
  PEPITE_MIN_VALUE_COMPARABLES,
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_V1_1_RULE_VERSION,
  PEPITE_V1_2_RULE_VERSION,
  PEPITE_V1_RULE_VERSION,
  PEPITE_V2_1_RULE_VERSION,
} from "@/lib/pepite-policy";
import { MIN_COURT_SAMPLE, MIN_NATIONAL_SAMPLE } from "@/lib/auction-scenarios";

/**
 * Adresse et seuils publiés sur « Comment repérons-nous les pépites ? ».
 *
 * Les seuils sont ceux de la règle `pepite-v1`, validée par le fondateur le 26/10/2026 (compte-rendu
 * `docs/equipe/2026-10-26-plafond-tous-types-et-selection.md`), repris tels quels par `pepite-v1.1` (règle
 * 28/10/2026 : mêmes seuils, critères corrigés) puis par `pepite-v1.2` (règle appliquée, 29/10/2026 : mêmes seuils
 * pour les deux critères chiffrés, plus les seuils de `PEPITE_V12_RULE_PARAMS`) et `pepite-v2.1`, qui n'ajoute à
 * `pepite-v1.2` que le critère éliminatoire du risque d'inondation (aucun seuil chiffré : un verdict). Ils viennent des
 * constantes de la règle (`src/lib/pepite-policy.ts`), le module pur qui sert aussi au calcul : la page ne peut
 * donc pas annoncer un seuil que le calcul n'applique pas. Quand la règle change (nouvelle version), cette
 * page change avec elle, et le test de la page (`page.test.tsx`) doit être mis à jour dans le même
 * geste. Le module de la règle ne lit ni la base ni le catalogue : la page non plus.
 */
export { PEPITE_METHOD_PATH } from "@/lib/pepite-copy";

/**
 * Lissage des ventes comparables, tel que le calcule la base (fonction `app_private.court_auction_scenarios`,
 * migration `supabase/migrations/20261101120100_auction_scenarios_reliability.sql`). Ces valeurs sont recopiées
 * du SQL : si la migration change, les changer ici et le texte de la page dans le même geste.
 * - moins de `minNationalSales` ventes comparables en France : aucun chiffre ;
 * - moins de `minCourtSales` ventes au tribunal : part nationale seule ; sinon
 *   (ventes du tribunal + `smoothingWeightSales` x part nationale) / (ventes du tribunal + `smoothingWeightSales`) ;
 * - fourchette de prix : ventes du tribunal seules à partir de `priceCourtOnlyFromSales`, nationales en dessous.
 * `minNationalSales` et `minCourtSales` viennent de `src/lib/auction-scenarios.ts` (test de dérive dans la page).
 */
export const PEPITE_SMOOTHING = {
  minNationalSales: MIN_NATIONAL_SAMPLE,
  minCourtSales: MIN_COURT_SAMPLE,
  smoothingWeightSales: 15,
  priceCourtOnlyFromSales: 20,
} as const;

export {
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_V1_1_RULE_VERSION,
  PEPITE_V1_2_RULE_VERSION,
  PEPITE_V1_RULE_VERSION,
  PEPITE_V2_1_RULE_VERSION,
};

/**
 * Date d'entrée en vigueur du contrôle du risque d'inondation (règle `pepite-v2.1`, avant elle `pepite-v2`, jamais
 * appliquée), écrite en toutes lettres (« 27 novembre 2026 »), À RENSEIGNER À LA BASCULE (voir
 * `docs/operations/planification.md`, « Règle pepite-v2 »), en même temps que l'ouverture de l'interrupteur
 * `PEPITE_RULE_V2_ENABLED`. Tant qu'elle est `null`, la page qui décrit la v2.1 (interrupteur ouvert) n'écrit pas de
 * date : jamais d'espace réservé visible du public.
 */
export const PEPITE_V2_EFFECTIVE_DATE: string | null = null;

/** « (en vigueur le 27 novembre 2026) » ou rien quand la date n'est pas encore renseignée. */
export function pepiteV2EffectiveClause(date: string | null = PEPITE_V2_EFFECTIVE_DATE): string {
  return date ? ` (en vigueur le ${date})` : "";
}

/**
 * Date d'entrée en vigueur de la règle `pepite-v1.2` (validée le 29/10/2026), écrite en toutes lettres, À RENSEIGNER
 * À LA MISE EN PRODUCTION de la règle. Tant qu'elle est `null`, la page n'écrit pas de date.
 */
export const PEPITE_V1_2_EFFECTIVE_DATE: string | null = null;

export function pepiteV12EffectiveClause(date: string | null = PEPITE_V1_2_EFFECTIVE_DATE): string {
  return date ? ` (en vigueur le ${date})` : "";
}

/** Une part (0 à 1) de la règle, en pourcentage entier pour la page. */
const percent = (share: number) => Math.round(share * 100);

/**
 * Seuils de la règle, communs à `pepite-v1`, `pepite-v1.1` et `pepite-v2` (la v1.1 ajoute une exigence, la borne
 * basse de Wilson ; la v2 n'en change aucun). Le nom ne porte plus la
 * version : un seuil qui changerait créerait une nouvelle version de règle, et cette table suivrait la règle
 * courante.
 */
export const PEPITE_RULE_PARAMS = {
  /** Test B (tribunal) : part minimale des ventes comparables adjugées sous l'enchère plafond, en %. */
  chanceMinPct: percent(PEPITE_CHANCE_MIN_SHARE),
  /** Test B, à l'entrée (pepite-v1.1 et suivantes) : borne basse de l'intervalle de Wilson à 95 % de la part, en %. */
  chanceMinWilsonLowPct: percent(PEPITE_CHANCE_MIN_WILSON_LOW),
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
  /** Lissage des ventes comparables (voir `PEPITE_SMOOTHING` et la migration citée plus haut). */
  minNationalSales: PEPITE_SMOOTHING.minNationalSales,
  minCourtSales: PEPITE_SMOOTHING.minCourtSales,
  smoothingWeightSales: PEPITE_SMOOTHING.smoothingWeightSales,
  priceCourtOnlyFromSales: PEPITE_SMOOTHING.priceCourtOnlyFromSales,
  /** Mise à prix inférieure à cette part de la valeur estimée : on retient les trois quarts des ventes. */
  lowStartingPricePct: percent(PEPITE_LOW_STARTING_PRICE_SHARE),
  /** Âge maximal de l'évaluation affichée, en heures. */
  maxEvaluationAgeHours: PEPITE_MAX_EVALUATION_AGE_HOURS,
} as const;

/**
 * Seuils ajoutés par la règle `pepite-v1.2` (et repris par `pepite-v2.1`), relus des constantes de la règle comme
 * `PEPITE_RULE_PARAMS`. Les seuils des tests B et C ne changent pas : ils restent dans `PEPITE_RULE_PARAMS`. Les
 * bornes de prix au m² de l'agrégat de marché (300 et 25 000) ne sont pas publiées : elles écartent des erreurs de
 * saisie de la base DVF.
 */
export const PEPITE_V12_RULE_PARAMS = {
  /** Coût de rénovation énergétique ajouté au coût total du second critère, en euros par m² habitable. */
  energyRenovationFEurPerM2: PEPITE_ENERGY_RENOVATION_EUR_PER_M2.F,
  energyRenovationGEurPerM2: PEPITE_ENERGY_RENOVATION_EUR_PER_M2.G,
  /** Confiance minimale du rapprochement du diagnostic de l'ADEME pour qu'il prime sur l'annonce. */
  dpeMinConfidence: PEPITE_DPE_MIN_CONFIDENCE,
  /** Marché local : ventes minimales sur la fenêtre, et taille de la fenêtre en mois. */
  marketMinSales: PEPITE_MARKET_MIN_SALES_12_MONTHS,
  marketWindowMonths: PEPITE_MARKET_WINDOW_MONTHS,
  /** Baisse maximale du prix médian au m², en %, sur `marketTrendYears` ans. */
  marketMaxDeclinePct: percent(PEPITE_MARKET_MAX_DECLINE_SHARE),
  marketTrendYears: PEPITE_MARKET_TREND_YEARS,
  /** Ventes minimales de chacune des deux années pour évaluer la tendance. */
  marketTrendMinSalesPerYear: PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR,
  /** Taille et valeur : surface habitable maximale (m²) et valeur estimée maximale (euros). */
  maxHabitableSurfaceM2: PEPITE_MAX_HABITABLE_SURFACE_M2,
  maxCentralValueEur: PEPITE_MAX_CENTRAL_VALUE_EUR,
} as const;
