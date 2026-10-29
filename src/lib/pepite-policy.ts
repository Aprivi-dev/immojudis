// Règles « pepite » (v1 à v2.1) : ce qu'est une pépite, et comment un résultat devient publiable. Module pur :
// aucune donnée, aucun import serveur. Les seuils sont des constantes exportées, que la page
// « Comment repérons-nous les pépites ? » (`src/app/methode-pepites/method.ts`) relit : un seuil
// change ici ou nulle part, et toute modification crée une nouvelle version (`PEPITE_LATEST_RULE_VERSION`).
//
// Une pépite est une vente qui remplit deux conditions chiffrées, calculées sur les données
// disponibles :
//   B : de bonnes chances de remporter la vente sans dépasser l'enchère plafond de référence
//       (tribunal seulement : c'est le seul type qui a un historique de prix d'adjudication) ;
//   C : à ce prix, l'achat est nettement sous la valeur du bien, frais compris.
// Le plafond de référence est calculé sur la valeur basse (P10) de l'estimation ; la valeur
// centrale sert au test C. Définition validée par le fondateur le 26/10/2026 (compte-rendu
// `docs/equipe/2026-10-26-plafond-tous-types-et-selection.md`).
//
// Ce qui n'entre JAMAIS dans le calcul : `investment_score`, les données d'avocat, de sponsoring et
// de profil. `scripts/check-security-invariants.mjs` vérifie que ce module et ceux qui le nourrissent
// n'importent aucun module d'avocats ou de sponsoring et ne lisent pas `investment_score`.
import type { AuctionScenario, ScenarioReliability } from "@/lib/auction-scenarios";
import type { FeeSource, OccupationCase } from "@/lib/bid-ceiling-engine";
import { ceilingPosition } from "@/lib/ceiling-vs-court";
import type { DpeClass } from "@/lib/dpe";
import type { FloodVerdict } from "@/lib/flood-risk";

/**
 * Versions de la règle. Chacune reste rejouable à l'identique (`evaluatePepite(input, version)`) et ne change
 * jamais une fois publiée ; ce qu'elle ajoute à la précédente est décrit par `PEPITE_RULE_CAPABILITIES`.
 *  - `pepite-v1` : la règle d'origine (26/10/2026) ;
 *  - `pepite-v1.1` : la règle d'origine corrigée (compte-rendu du 27/10/2026, n° 20 à 23 et 26) : test B réussi
 *    seulement si la part plancher atteint le seuil, borne basse de Wilson, frais connus en vente notariale,
 *    décote d'occupation sur la valeur du test C, fiabilité « forte » sous 30 % de la valeur, et qualité de
 *    l'estimation bloquante pendant le gel ;
 *  - `pepite-v2` : `pepite-v1.1` plus le critère éliminatoire du risque d'inondation (module `flood-risk.ts`) ;
 *  - `pepite-v1.2` (validée le 29/10/2026) : `pepite-v1.1` plus le coût de rénovation énergétique dans le test C
 *    (DPE F ou G), le marché local (liquidité et tendance des prix de la commune, d'après les ventes DVF), le
 *    plafond de taille et de valeur, et la copropriété en difficulté (bloquant). Les seuils des tests B et C ne
 *    changent pas. C'est la règle APPLIQUÉE tant que l'interrupteur serveur `PEPITE_RULE_V2_ENABLED` est fermé
 *    (`pepite-rule-switch.server.ts`) ;
 *  - `pepite-v2.1` (version courante) : `pepite-v1.2` plus le critère d'inondation de `pepite-v2`. Appliquée
 *    quand l'interrupteur est ouvert.
 */
export const PEPITE_V1_RULE_VERSION = "pepite-v1";
export const PEPITE_V1_1_RULE_VERSION = "pepite-v1.1";
export const PEPITE_V2_RULE_VERSION = "pepite-v2";
export const PEPITE_V1_2_RULE_VERSION = "pepite-v1.2";
export const PEPITE_V2_1_RULE_VERSION = "pepite-v2.1";
export const PEPITE_LATEST_RULE_VERSION = PEPITE_V2_1_RULE_VERSION;
export type PepiteRuleVersion =
  | typeof PEPITE_V1_RULE_VERSION
  | typeof PEPITE_V1_1_RULE_VERSION
  | typeof PEPITE_V2_RULE_VERSION
  | typeof PEPITE_V1_2_RULE_VERSION
  | typeof PEPITE_V2_1_RULE_VERSION;

/** Ce que chaque version de la règle évalue : une capacité absente, la version se comporte comme avant elle. */
export type PepiteRuleCapabilities = {
  /** Corrections du 27/10/2026 (pepite-v1.1 et suivantes). */
  corrected: boolean;
  /** Critère éliminatoire du risque d'inondation. */
  flood: boolean;
  /** Coût de rénovation énergétique (DPE F ou G) ajouté au coût total du test C. */
  energyCost: boolean;
  /** Marché local : `market_liquid` et `market_not_declining`. */
  localMarket: boolean;
  /** Plafond de taille et de valeur : `size_value_supported`. */
  sizeValueCap: boolean;
  /** Copropriété en difficulté : `no_copro_distress` (bloquant). */
  coproDistress: boolean;
};

const NO_CAPABILITY: PepiteRuleCapabilities = {
  corrected: false,
  flood: false,
  energyCost: false,
  localMarket: false,
  sizeValueCap: false,
  coproDistress: false,
};
const CORRECTED: PepiteRuleCapabilities = { ...NO_CAPABILITY, corrected: true };
const V1_2: PepiteRuleCapabilities = {
  ...CORRECTED,
  energyCost: true,
  localMarket: true,
  sizeValueCap: true,
  coproDistress: true,
};

/** Table de capacités par version : c'est elle, et elle seule, qui décide de ce qu'une version évalue. */
export const PEPITE_RULE_CAPABILITIES: Readonly<
  Record<PepiteRuleVersion, Readonly<PepiteRuleCapabilities>>
> = {
  "pepite-v1": NO_CAPABILITY,
  "pepite-v1.1": CORRECTED,
  "pepite-v2": { ...CORRECTED, flood: true },
  "pepite-v1.2": V1_2,
  "pepite-v2.1": { ...V1_2, flood: true },
};

export function pepiteRuleCapabilities(ruleVersion: PepiteRuleVersion): PepiteRuleCapabilities {
  return PEPITE_RULE_CAPABILITIES[ruleVersion];
}

/** La version lit des données de la règle v1.2 (DPE, marché local, pièces, loyer) : le traitement les charge. */
export function readsPepiteV12Data(ruleVersion: PepiteRuleVersion): boolean {
  const capabilities = pepiteRuleCapabilities(ruleVersion);
  return capabilities.energyCost || capabilities.localMarket || capabilities.coproDistress;
}

/** Test B, entrée : part minimale des ventes comparables adjugées sous l'enchère plafond. */
export const PEPITE_CHANCE_MIN_SHARE = 0.7;
/** Test B, sortie : la part redescend sous ce seuil (on entre à 70 %, on ne sort qu'à 65 %). */
export const PEPITE_CHANCE_EXIT_SHARE = 0.65;
/** Test C, tribunal : coût total probable au plus égal à cette part de la valeur centrale. */
export const PEPITE_COST_MAX_SHARE_COURT = 0.75;
/** Test C, ventes notariales : même rapport, seuil plus strict. */
export const PEPITE_COST_MAX_SHARE_NOTARY = 0.65;
/** Test C, sortie, tribunal : le rapport dépasse ce seuil (on entre à 75 %). */
export const PEPITE_COST_EXIT_SHARE_COURT = 0.8;
/** Test C, sortie, ventes notariales : même écart d'hystérésis qu'au tribunal (on entre à 65 %). */
export const PEPITE_COST_EXIT_SHARE_NOTARY = 0.7;
/**
 * Garde-fou « écart extrême » : une mise à prix (ou première offre) sous cette part de la valeur centrale,
 * ou au-dessus de `PEPITE_EXTREME_START_RATIO_MAX`, signale le plus souvent une erreur de données (surface,
 * lot, type de bien), pas une affaire. Seuil propre à la règle : il ne reprend pas celui de `market-gap.ts`
 * (qui sert au repère public) ; entre 10 % et 30 % la vente reste candidate et q75 s'applique.
 */
export const PEPITE_EXTREME_START_RATIO_MIN = 0.1;
/** Mise à prix au-dessus de cette part (150 %) de la valeur centrale : écartée. */
export const PEPITE_EXTREME_START_RATIO_MAX = 1.5;
/** Évaluations favorables consécutives avant l'apparition. */
export const PEPITE_FAVOURABLE_EVALUATIONS = 2;
/**
 * Deux évaluations favorables ne comptent comme consécutives que si elles sont espacées d'au moins ce
 * nombre d'heures (de la dernière évaluation comptée) : `updated_at` d'une vente bouge à chaque collecte,
 * et deux passages à une heure d'écart sur les mêmes données ne sont pas deux observations indépendantes.
 */
export const PEPITE_MIN_HOURS_BETWEEN_EVALUATIONS = 12;
/**
 * Une pépite publiée ne sort pas sur une donnée transitoirement manquante (estimation en cours de recalcul,
 * panne de lecture) : elle est tolérée pendant ce nombre d'heures, sans changer, puis sort. Un seuil de
 * sortie ou un signal bloquant la fait sortir tout de suite.
 */
export const PEPITE_DATA_GRACE_HOURS = 24;
/** Le résultat est figé ce nombre de jours avant la vente. */
export const PEPITE_FREEZE_DAYS = 7;
/** Échantillon effectif minimal de l'estimation de valeur. */
export const PEPITE_MIN_VALUE_COMPARABLES = 8;
/** Estimation de valeur : fiabilité admise (`qualityLabel`). */
export const PEPITE_VALUE_RELIABILITIES: readonly string[] = ["forte", "correcte"];
/** Historique des ventes comparables, en années (`app_private.court_auction_scenarios`). */
export const PEPITE_HISTORY_YEARS = 3;
/** Sous ce nombre de ventes du tribunal, on complète par le taux national. */
export const PEPITE_COURT_COMPLETE_BELOW_SALES = 30;
/** Sous ce nombre de ventes du tribunal, on le remplace par le taux national. */
export const PEPITE_COURT_REPLACE_BELOW_SALES = 10;
/**
 * Lissage de la part du test B (SQL `app_private.court_auction_scenarios`, migration 20261101120100) : à partir
 * de `PEPITE_COURT_REPLACE_BELOW_SALES` ventes du tribunal, la part est (ventes du tribunal + 15 x taux national)
 * / (ventes du tribunal + 15), quel que soit l'effectif. Sous ce seuil, la part est celle du national seul.
 */
export const PEPITE_SMOOTHING_WEIGHT_SALES = 15;
/** Fourchette de prix (quantiles) : lots du tribunal seuls à partir de ce nombre de ventes, national en dessous. */
export const PEPITE_PRICE_COURT_ONLY_FROM_SALES = 20;
/** Ventes nationales comparables minimales : en dessous, aucun chiffre. */
export const PEPITE_MIN_NATIONAL_SALES = 30;
/** Test B (pepite-v1.1 et suivantes), entrée : borne basse de l'intervalle de Wilson à 95 % de la part. */
export const PEPITE_CHANCE_MIN_WILSON_LOW = 0.5;
/** Quantile de la loi normale pour l'intervalle de Wilson à 95 % (même valeur que les statistiques des tribunaux). */
const WILSON_Z_95 = 1.959964;
/** Fiabilité minimale des scénarios d'adjudication : en dessous, le test B n'est pas évaluable. */
export const PEPITE_MIN_SCENARIO_RELIABILITY: ScenarioReliability = "medium";
/** Mise à prix inférieure à cette part de la valeur centrale : on retient q75 au lieu de q50. */
export const PEPITE_LOW_STARTING_PRICE_SHARE = 0.3;
/** Âge maximal d'une évaluation lue publiquement, en heures (garde de lecture de la base). */
export const PEPITE_MAX_EVALUATION_AGE_HOURS = 36;
/** Une évaluation plus ancienne est refaite par le traitement planifié. */
export const PEPITE_REFRESH_HOURS = 24;
/** Taux de pépites visé parmi les ventes évaluables (information), et plage hors de laquelle on alerte. */
export const PEPITE_TARGET_RATE_MIN = 0.05;
export const PEPITE_TARGET_RATE_MAX = 0.1;
export const PEPITE_RATE_ALERT_MIN = 0.02;
export const PEPITE_RATE_ALERT_MAX = 0.15;

// --- pepite-v1.2 (validée le 29/10/2026) : les seuils des tests B et C ne changent pas. -----------------------------

/**
 * Coût de rénovation énergétique (pepite-v1.2), en euros par m² habitable, ajouté au coût total du test C : DPE F
 * 250 EUR/m², DPE G 400 EUR/m². Aucune autre classe n'ajoute de coût.
 */
export const PEPITE_ENERGY_RENOVATION_EUR_PER_M2: Readonly<Record<"F" | "G", number>> = {
  F: 250,
  G: 400,
};
/** Confiance minimale du rapprochement ADEME (`auction_dpe_diagnostics.confidence`) pour que son DPE prime sur celui de l'annonce. */
export const PEPITE_DPE_MIN_CONFIDENCE = 0.8;
/** Marché local, liquidité : ventes DVF minimales de logements du même type dans la commune sur les 12 derniers mois disponibles. */
export const PEPITE_MARKET_MIN_SALES_12_MONTHS = 20;
/** Marché local, tendance : baisse maximale admise du prix médian au m² entre l'année la plus récente et trois ans plus tôt. */
export const PEPITE_MARKET_MAX_DECLINE_SHARE = 0.15;
/** Marché local, tendance : écart en années entre l'année la plus récente et l'année de comparaison. */
export const PEPITE_MARKET_TREND_YEARS = 3;
/** Marché local, tendance : ventes minimales de CHACUNE des deux années pour évaluer la tendance (sinon réussie). */
export const PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR = 10;
/** Ventes DVF retenues pour l'agrégat de marché : prix au m² entre ces bornes (écarte les erreurs de saisie). */
export const PEPITE_MARKET_PRICE_PER_M2_MIN = 300;
export const PEPITE_MARKET_PRICE_PER_M2_MAX = 25_000;
/** Fenêtre de liquidité, en mois, comptée depuis la dernière vente disponible de `dvf_transactions`. */
export const PEPITE_MARKET_WINDOW_MONTHS = 12;
/** Types de logement de l'agrégat de marché (valeurs de `dvf_transactions.property_type`). */
export const PEPITE_MARKET_PROPERTY_TYPES = ["Maison", "Appartement"] as const;
export type PepiteMarketPropertyType = (typeof PEPITE_MARKET_PROPERTY_TYPES)[number];
/** Taille et valeur : au-delà de cette surface habitable (m²) ou de cette valeur centrale (EUR), le bien est écarté. */
export const PEPITE_MAX_HABITABLE_SURFACE_M2 = 250;
export const PEPITE_MAX_CENTRAL_VALUE_EUR = 1_500_000;

export type PepiteRegimeKey = "tribunal" | "notary_auction" | "notary_online";
/**
 * `pepite` : la vente remplit tous les critères d'entrée à cette évaluation (pas encore publiable :
 * voir `applyPepiteStability`) ; `not_pepite` : évaluable, au moins un critère manqué ;
 * `not_applicable` : pas de régime ouvert ou vente pas à venir ; `insufficient` : une donnée
 * indispensable manque (estimation, plafond, scénarios d'adjudication, mise à prix).
 */
export type PepiteStatus = "pepite" | "not_pepite" | "not_applicable" | "insufficient";

/** Un critère par code de motif : chaque critère évalué est réussi (`pass:`) ou manqué (`fail:`). */
export const PEPITE_CRITERIA = [
  // Ventes couvertes.
  "regime_open",
  "sale_upcoming",
  // Données indispensables : sans elles, la vente est « données insuffisantes ».
  "starting_price_known",
  "estimate_actionable",
  "ceiling_computed",
  "scenarios_reliable",
  // Garde-fous sur l'estimation et le bien.
  "estimate_reliability",
  "estimate_sample",
  "surface_known",
  "public_gap_gate",
  "gap_significant",
  "property_type_supported",
  "occupancy_known",
  // pepite-v1.1 et suivantes : frais de la vente notariale lus (pas des valeurs par défaut) ; mise à prix sous
  // 30 % de la valeur : estimation de fiabilité « forte » exigée.
  "fees_known",
  "low_start_strong_estimate",
  // pepite-v1.2 : éliminatoires, non bloquants. Taille et valeur du bien ; marché local de la commune (une donnée
  // de marché absente ne les fait pas échouer).
  "size_value_supported",
  "market_liquid",
  "market_not_declining",
  // Inondation (pepite-v2 et v2.1) : exigée à l'entrée, tolérée au maintien, jamais affichée.
  "flood_risk_known",
  // Signaux bloquants.
  "no_valuation_conflict",
  "no_ai_block",
  "no_degraded_condition",
  "verification_not_conflict",
  "no_probable_duplicate",
  "risks_qualified",
  // pepite-v1.2 : copropriété en difficulté lue dans une pièce du dossier (bloquant).
  "no_copro_distress",
  // Inondation (pepite-v2 et v2.1) : bloquant, évalué seulement quand le verdict est connu.
  "no_high_flood_risk",
  // Tests.
  "test_b_chance",
  "test_c_cost",
  "ceiling_above_start",
] as const;
export type PepiteCriterionId = (typeof PEPITE_CRITERIA)[number];

/**
 * Données dont l'absence rend l'évaluation impossible (statut « données insuffisantes »). Pour
 * `ceiling_computed`, seule l'ABSENCE de plafond compte : un plafond calculé mais nul, ou sous la première
 * offre d'une vente interactive, est un résultat (« pas une pépite »), pas une donnée manquante.
 */
export const PEPITE_DATA_CRITERIA: readonly PepiteCriterionId[] = [
  "starting_price_known",
  "estimate_actionable",
  "ceiling_computed",
  "scenarios_reliable",
];
/**
 * Signaux bloquants : leur apparition fait sortir la vente, même figée. L'occupation inconnue ou
 * squattée en fait partie : un bien qui devient squatté n'est plus une pépite, figée ou non.
 */
export const PEPITE_BLOCKING_CRITERIA: readonly PepiteCriterionId[] = [
  "no_valuation_conflict",
  "no_ai_block",
  "no_degraded_condition",
  "verification_not_conflict",
  "no_probable_duplicate",
  "risks_qualified",
  "occupancy_known",
  // pepite-v1.2 : une copropriété en difficulté (administrateur provisoire, plan de sauvegarde, mandataire ad hoc,
  // carence) fait sortir une pépite publiée, même gelée à J-7. Les critères de marché et de taille ne sont PAS
  // bloquants : ils ne jouent qu'au recalcul normal.
  "no_copro_distress",
  // Seul un risque d'inondation ÉLEVÉ fait sortir une pépite publiée, même gelée à J-7.
  "no_high_flood_risk",
];

/**
 * Qualité de l'estimation qui, manquée pendant le gel à J-7, fait sortir une pépite publiée (pepite-v1.1 et
 * suivantes) : la pépite ne reste pas affichée sur une estimation qui ne la justifie plus.
 */
export const PEPITE_FREEZE_QUALITY_CRITERIA: readonly PepiteCriterionId[] = [
  "public_gap_gate",
  "estimate_reliability",
  "estimate_actionable",
];

export type PepiteEstimateInput = {
  /** L'estimation est exploitable (`actionable`). */
  actionable: boolean;
  /** `qualityLabel` de l'estimation : « forte », « correcte » ou « fragile ». */
  reliability: string | null;
  effectiveSampleSize: number | null;
  /** Surface estimée (et non enregistrée), pour le bien ou pour l'estimation. */
  surfaceEstimated: boolean;
  /** Porte publique de la bande d'écart au marché (`passesPublicMarketGapGate`). */
  publicGatePassed: boolean;
  /** Valeur centrale (P50) : sert au test C et à la règle q50 / q75. */
  centralValueEur: number | null;
  /** Valeur basse (P10) : le plafond de référence est calculé dessus. */
  lowValueEur: number | null;
};

export type PepiteCeilingInput = {
  /** Le plan du plafond est calculable (valeur et surface connues). */
  available: boolean;
  /** Enchère plafond de référence, calculée sur la valeur P10 ; 0 quand aucune enchère ne tient. */
  referenceEur: number | null;
  /** Coût total d'achat à un prix donné : prix, frais du régime et libération si le bien est occupé. */
  totalCostAt: (priceEur: number) => number | null;
};

export type PepiteScenariosInput = {
  reliability: ScenarioReliability | null;
  buckets: readonly AuctionScenario[];
  q25: number | null;
  q50: number | null;
  q75: number | null;
  courtSample: number;
  nationalSample: number;
} | null;

/**
 * Source de chaque poste de frais du coût d'achat (`feesSource` du moteur de plafond) : `defaut` signale un
 * montant non lu, ni saisi (pepite-v1.1 : refusé en vente notariale, signalé en administration au tribunal).
 */
export type PepiteFeesInput = {
  /** Frais préalables (tribunal) ; `null` : sans objet. */
  preliminary: FeeSource | null;
  /** Honoraires de négociation de l'acquéreur (vente interactive) ; `null` : sans objet. */
  negotiation: FeeSource | null;
  /** Frais de publicité de l'acquéreur (vente interactive) ; `null` : sans objet. */
  advertising: FeeSource | null;
};

export type PepiteSignals = {
  /** Terrain seul ou actif mixte. */
  landOrMixed: boolean;
  occupancy: OccupationCase;
  /** État dégradé documenté dans l'annonce ou les pièces. */
  degradedCondition: boolean;
  valuationConflict: boolean;
  /** Champ critique (mise à prix, surface, type, pièces) bloqué par la relecture IA. */
  aiBlocked: boolean;
  /** `sale_verification_status = conflict`. */
  verificationConflict: boolean;
  probableDuplicate: boolean;
  /** `score_status = withheld_unqualified_risks`. */
  unqualifiedRisks: boolean;
  /**
   * Une pièce lue du dossier mentionne explicitement une copropriété en difficulté (`pepite-copro.ts`) ; pepite-v1.2
   * et suivantes. Absent : aucune pièce lue, ou règle sans ce critère.
   */
  coproDistress?: boolean;
};

/**
 * DPE retenu pour le coût de rénovation énergétique (pepite-v1.2) : la classe de l'ADEME quand son rapprochement a
 * une confiance d'au moins `PEPITE_DPE_MIN_CONFIDENCE`, sinon celle de l'annonce (`pepite-energy.ts`). `dpeClass`
 * nul : DPE inconnu, aucun coût ajouté, signalé dans les détails.
 */
export type PepiteEnergyInput = {
  dpeClass: DpeClass | null;
  dpeSource: "ademe" | "listing" | null;
};

/**
 * Agrégat DVF de la commune pour le type de logement de la vente (`app_private.commune_market_trends`). Les ventes
 * sont celles de `dvf_transactions` (`mutation_nature = 'Vente'`, prix au m² entre 300 et 25 000).
 */
export type PepiteMarketAggregate = {
  /** Année la plus récente disponible. */
  referenceYear: number;
  /** Ventes sur les 12 derniers mois disponibles. */
  sales12Months: number;
  /** Prix médian au m² de l'année la plus récente et de trois ans plus tôt ; `null` sans vente. */
  medianRecentEurM2: number | null;
  medianBaselineEurM2: number | null;
  /** Ventes de chacune des deux années. */
  salesRecentYear: number;
  salesBaselineYear: number;
};

/** Le marché local de la vente. `aggregate` nul : aucun agrégat pour cette commune et ce type (critères réussis). */
export type PepiteMarketInput = {
  propertyType: PepiteMarketPropertyType | null;
  aggregate: PepiteMarketAggregate | null;
};

/**
 * Le verdict d'inondation de la vente (`flood-risk.ts`), lu dans la table privée : jamais un appel réseau.
 * `ppriChecked` : le périmètre des PPRi a pu être lu au dernier contrôle (vrai aussi quand il ne s'applique pas).
 */
export type PepiteFloodInput = { verdict: FloodVerdict; ppriChecked: boolean };

export type PepiteInput = {
  /** Régime de frais de la vente quand son calcul est ouvert ; `null` : pas de pépite. */
  regime: PepiteRegimeKey | null;
  /** Vente à venir, datée dans le futur. */
  upcoming: boolean;
  /** Mise à prix ; première offre possible pour une vente interactive. */
  startingPriceEur: number | null;
  estimate: PepiteEstimateInput | null;
  ceiling: PepiteCeilingInput | null;
  scenarios: PepiteScenariosInput;
  signals: PepiteSignals;
  /** Verdict d'inondation ; ignoré par `pepite-v1` et `pepite-v1.1`. */
  flood: PepiteFloodInput;
  /** Sources des frais (pepite-v1.1 et suivantes) ; absent : critère `fees_known` non évalué. */
  fees?: PepiteFeesInput | null;
  /**
   * Décote d'occupation de la valeur centrale, en % (0 à 50) : bien loué, `rentedDiscountPct` du moteur de
   * plafond ; bien libre ou occupé (frais de libération déjà comptés dans le coût), 0. Pepite-v1.1 et suivantes.
   */
  occupancyDiscountPct?: number;
  /** Surface habitable (m²) : sert au coût énergétique et au plafond de taille (pepite-v1.2 et suivantes). */
  habitableSurfaceM2?: number | null;
  /** DPE retenu (pepite-v1.2 et suivantes) ; absent : DPE inconnu. */
  energy?: PepiteEnergyInput | null;
  /** Marché local (pepite-v1.2 et suivantes) ; absent : aucun agrégat, critères de marché réussis. */
  market?: PepiteMarketInput | null;
};

/** Ce que le marché local a donné pour cette vente, stocké dans `details.market`. */
export type PepiteMarketMetrics = {
  propertyType: PepiteMarketPropertyType | null;
  /** Aucun agrégat pour la commune et ce type : les deux critères sont réussis, faute de donnée. */
  aggregateAbsent: boolean;
  referenceYear: number | null;
  sales12Months: number | null;
  salesRecentYear: number | null;
  salesBaselineYear: number | null;
  medianRecentEurM2: number | null;
  medianBaselineEurM2: number | null;
  /** La tendance a pu être évaluée (au moins 10 ventes chacune des deux années, deux médianes). */
  trendEvaluated: boolean;
  /** Baisse du prix médian au m² entre les deux années, en % (négatif : hausse) ; `null` si non évaluée. */
  declinePct: number | null;
};

export type PepiteMetrics = {
  startingPriceEur: number | null;
  centralValueEur: number | null;
  lowValueEur: number | null;
  /** Enchère plafond de référence (valeur P10). */
  referenceCeilingEur: number | null;
  /** Multiplicateur retenu : q50, q75 (mise à prix basse) ou le prix de départ lui-même. */
  multiplierKey: "q50" | "q75" | "start" | null;
  multiplier: number | null;
  probablePriceEur: number | null;
  rangeLowEur: number | null;
  rangeHighEur: number | null;
  /** Test B : part des ventes comparables adjugées sous le plafond (0 à 1). */
  chanceShare: number | null;
  /** La part est un plancher (« au moins »). */
  chanceAtLeast: boolean;
  /** Effectif sur lequel la part est lissée (tribunal + poids national) ; `null` : sans objet. */
  chanceSample: number | null;
  /** Borne basse de l'intervalle de Wilson à 95 % de la part (0 à 1). */
  chanceWilsonLow: number | null;
  /** Décote d'occupation appliquée à la valeur centrale du test C, en % (pepite-v1.1 et suivantes). */
  occupancyDiscountPct: number | null;
  /** Un frais du coût d'achat est une valeur par défaut (frais préalables, négociation ou publicité). */
  feesDefault: boolean;
  /** Le plafond est sous la mise à prix : aucune enchère n'est possible. */
  ceilingBelowStart: boolean;
  /** Test C : coût total au prix probable, et ce coût rapporté à la valeur centrale. */
  totalCostEur: number | null;
  costRatio: number | null;
  /** Mise à prix rapportée à la valeur centrale. */
  startingShareOfValue: number | null;
  /**
   * pepite-v1.2 et suivantes (absents des versions antérieures) : DPE retenu (`null` : inconnu, aucun coût ajouté),
   * sa source, et le coût de rénovation énergétique ajouté au coût total du test C (0 hors F et G ; `null` : DPE
   * inconnu ou surface habitable inconnue).
   */
  dpeClass?: DpeClass | null;
  dpeSource?: "ademe" | "listing" | null;
  energyRenovationEur?: number | null;
  /** Surface habitable lue pour le coût énergétique et le plafond de taille. */
  habitableSurfaceM2?: number | null;
  /** Marché local (pepite-v1.2 et suivantes). */
  market?: PepiteMarketMetrics | null;
};

export type PepiteEvaluation = {
  ruleVersion: string;
  status: PepiteStatus;
  regime: PepiteRegimeKey | null;
  /** Tous les critères d'entrée sont réussis. */
  favorable: boolean;
  /** Une porte de qualité de l'estimation est manquée (`PEPITE_FREEZE_QUALITY_CRITERIA`, pepite-v1.1 et suivantes). */
  frozenQualityMissed: boolean;
  /** La vente tient toujours aux seuils de sortie (hystérésis). */
  holds: boolean;
  /** Au moins un signal bloquant. */
  blocking: boolean;
  passed: PepiteCriterionId[];
  missed: PepiteCriterionId[];
  /** Critères manqués aux seuils de sortie : ce qui ferait sortir une pépite publiée. */
  holdMissed: PepiteCriterionId[];
  metrics: PepiteMetrics;
};

const RELIABILITY_RANK: Record<ScenarioReliability, number> = { low: 0, medium: 1, good: 2 };

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

const EMPTY_METRICS: PepiteMetrics = {
  startingPriceEur: null,
  centralValueEur: null,
  lowValueEur: null,
  referenceCeilingEur: null,
  multiplierKey: null,
  multiplier: null,
  probablePriceEur: null,
  rangeLowEur: null,
  rangeHighEur: null,
  chanceShare: null,
  chanceAtLeast: false,
  chanceSample: null,
  chanceWilsonLow: null,
  occupancyDiscountPct: null,
  feesDefault: false,
  ceilingBelowStart: false,
  totalCostEur: null,
  costRatio: null,
  startingShareOfValue: null,
};

/**
 * Inondation selon le jeu de seuils : `entry` (entrée : verdict connu exigé, risque élevé refusé), `hold`
 * (maintien : verdict inconnu toléré, risque élevé refusé) ou `off` (pepite-v1 : aucun critère d'inondation).
 */
type FloodMode = "entry" | "hold" | "off";

type Thresholds = {
  /** Ce que la version évalue (table de capacités). */
  capabilities: PepiteRuleCapabilities;
  chanceMinShare: number;
  /** Borne basse de Wilson exigée de la part ; `null` : non exigée (maintien, règle d'origine). */
  chanceMinWilsonLow: number | null;
  costMaxShare: number;
  flood: FloodMode;
  /** Corrections du 27/10/2026 (pepite-v1.1 et suivantes). */
  corrected: boolean;
};

/** Borne basse de l'intervalle de Wilson à 95 % d'une part observée sur `sample` ventes. */
export function wilsonLowerBound(share: number, sample: number): number {
  if (!(sample > 0) || !Number.isFinite(share)) return 0;
  const p = Math.min(1, Math.max(0, share));
  const z2 = WILSON_Z_95 ** 2;
  const denominator = 1 + z2 / sample;
  const center = p + z2 / (2 * sample);
  const margin = WILSON_Z_95 * Math.sqrt((p * (1 - p)) / sample + z2 / (4 * sample ** 2));
  return Math.max(0, (center - margin) / denominator);
}

/**
 * Effectif sur lequel la part du test B est calculée par la base : tribunal + poids national dès 10 ventes du
 * tribunal, sinon les ventes nationales seules.
 */
export function chanceSampleSize(courtSample: number, nationalSample: number): number {
  return courtSample >= PEPITE_COURT_REPLACE_BELOW_SALES
    ? courtSample + PEPITE_SMOOTHING_WEIGHT_SALES
    : nationalSample;
}

/**
 * Coût de rénovation énergétique ajouté au test C (pepite-v1.2) : `PEPITE_ENERGY_RENOVATION_EUR_PER_M2` x surface
 * habitable pour un DPE F ou G, 0 pour les autres classes. `null` : DPE inconnu (aucun ajout, signalé dans les
 * détails), ou DPE F/G sans surface habitable connue.
 */
export function energyRenovationCostEur(
  dpeClass: DpeClass | null | undefined,
  habitableSurfaceM2: number | null | undefined,
): number | null {
  if (dpeClass == null) return null;
  if (dpeClass !== "F" && dpeClass !== "G") return 0;
  const surface = positive(habitableSurfaceM2);
  return surface == null
    ? null
    : Math.round(PEPITE_ENERGY_RENOVATION_EUR_PER_M2[dpeClass] * surface);
}

/**
 * Marché local de la commune (pepite-v1.2). Donnée manquante, pas d'exclusion :
 *  - `market_liquid` échoue seulement si l'agrégat existe et compte moins de `PEPITE_MARKET_MIN_SALES_12_MONTHS`
 *    ventes sur 12 mois ; sans agrégat il est réussi (et `aggregateAbsent` le note) ;
 *  - `market_not_declining` n'est évalué que si chacune des deux années a au moins
 *    `PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR` ventes et une médiane ; il échoue si le prix médian au m² a baissé de
 *    plus de `PEPITE_MARKET_MAX_DECLINE_SHARE` ; sinon il est réussi (`trendEvaluated` le note).
 */
export function evaluateLocalMarket(market: PepiteMarketInput | null | undefined): {
  liquid: boolean;
  notDeclining: boolean;
  metrics: PepiteMarketMetrics;
} {
  const aggregate = market?.aggregate ?? null;
  const metrics: PepiteMarketMetrics = {
    propertyType: market?.propertyType ?? null,
    aggregateAbsent: aggregate == null,
    referenceYear: aggregate?.referenceYear ?? null,
    sales12Months: aggregate?.sales12Months ?? null,
    salesRecentYear: aggregate?.salesRecentYear ?? null,
    salesBaselineYear: aggregate?.salesBaselineYear ?? null,
    medianRecentEurM2: aggregate?.medianRecentEurM2 ?? null,
    medianBaselineEurM2: aggregate?.medianBaselineEurM2 ?? null,
    trendEvaluated: false,
    declinePct: null,
  };
  if (!aggregate) return { liquid: true, notDeclining: true, metrics };

  const liquid = aggregate.sales12Months >= PEPITE_MARKET_MIN_SALES_12_MONTHS;
  const recent = positive(aggregate.medianRecentEurM2);
  const baseline = positive(aggregate.medianBaselineEurM2);
  const trendEvaluated =
    aggregate.salesRecentYear >= PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR &&
    aggregate.salesBaselineYear >= PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR &&
    recent != null &&
    baseline != null;
  metrics.trendEvaluated = trendEvaluated;
  if (!trendEvaluated || recent == null || baseline == null) {
    return { liquid, notDeclining: true, metrics };
  }
  const decline = (baseline - recent) / baseline;
  metrics.declinePct = Math.round(decline * 10_000) / 100;
  // Une baisse d'exactement 15 % est admise : seule une baisse de plus de 15 % exclut.
  return { liquid, notDeclining: !(decline > PEPITE_MARKET_MAX_DECLINE_SHARE + 1e-9), metrics };
}

/** Seuil du test C à l'entrée : plus strict pour les ventes notariales. */
function entryCostMaxShare(regime: PepiteRegimeKey): number {
  return regime === "tribunal" ? PEPITE_COST_MAX_SHARE_COURT : PEPITE_COST_MAX_SHARE_NOTARY;
}

/** Seuil du test C à la sortie : 80 % au tribunal, 70 % en vente notariale. */
function exitCostMaxShare(regime: PepiteRegimeKey): number {
  return regime === "tribunal" ? PEPITE_COST_EXIT_SHARE_COURT : PEPITE_COST_EXIT_SHARE_NOTARY;
}

/** Les critères réussis et manqués à des seuils donnés, et les mesures qui les fondent. */
function runCriteria(
  input: PepiteInput,
  regime: PepiteRegimeKey,
  thresholds: Thresholds,
): {
  passed: PepiteCriterionId[];
  missed: PepiteCriterionId[];
  metrics: PepiteMetrics;
  dataMissing: boolean;
} {
  const passed: PepiteCriterionId[] = [];
  const missed: PepiteCriterionId[] = [];
  const check = (id: PepiteCriterionId, ok: boolean) => (ok ? passed : missed).push(id);
  const { estimate, ceiling, scenarios, signals } = input;
  const court = regime === "tribunal";

  const start = positive(input.startingPriceEur);
  const central = positive(estimate?.centralValueEur);
  const low = positive(estimate?.lowValueEur);
  const reference = ceiling?.available ? (ceiling.referenceEur ?? null) : null;
  const quartiles =
    scenarios && Number.isFinite(scenarios.q25) && Number.isFinite(scenarios.q50)
      ? { q25: positive(scenarios.q25), q50: positive(scenarios.q50), q75: positive(scenarios.q75) }
      : null;
  const scenariosUsable =
    scenarios != null &&
    scenarios.reliability != null &&
    RELIABILITY_RANK[scenarios.reliability] >= RELIABILITY_RANK[PEPITE_MIN_SCENARIO_RELIABILITY] &&
    scenarios.buckets.length > 0 &&
    quartiles != null &&
    quartiles.q25 != null &&
    quartiles.q50 != null &&
    quartiles.q75 != null;

  // Données indispensables.
  check("starting_price_known", start != null);
  check("estimate_actionable", estimate?.actionable === true && central != null && low != null);
  // Plafond calculé ET exploitable : jamais nul ; en vente interactive, au moins la première offre possible
  // (sans cela aucune offre ne tient).
  check(
    "ceiling_computed",
    reference != null &&
      reference > 0 &&
      (regime !== "notary_online" || start == null || reference >= start),
  );
  if (court) check("scenarios_reliable", scenariosUsable);
  const dataMissing =
    start == null ||
    !(estimate?.actionable === true && central != null && low != null) ||
    reference == null ||
    (court && !scenariosUsable);

  // Garde-fous sur l'estimation et le bien.
  check(
    "estimate_reliability",
    estimate != null && PEPITE_VALUE_RELIABILITIES.includes(estimate.reliability ?? ""),
  );
  check(
    "estimate_sample",
    estimate?.effectiveSampleSize != null &&
      Number.isFinite(estimate.effectiveSampleSize) &&
      estimate.effectiveSampleSize >= PEPITE_MIN_VALUE_COMPARABLES,
  );
  check("surface_known", estimate != null && !estimate.surfaceEstimated);
  check("public_gap_gate", estimate?.publicGatePassed === true);
  // Écart extrême : mise à prix sous 10 % ou au-dessus de 150 % de la valeur centrale (bornes admises).
  check(
    "gap_significant",
    start != null &&
      central != null &&
      start / central >= PEPITE_EXTREME_START_RATIO_MIN &&
      start / central <= PEPITE_EXTREME_START_RATIO_MAX,
  );
  check("property_type_supported", !signals.landOrMixed);
  check(
    "occupancy_known",
    signals.occupancy === "libre" || signals.occupancy === "occupe" || signals.occupancy === "loue",
  );
  // pepite-v1.1 : en vente notariale, des honoraires de négociation ou des frais de publicité « par défaut » ne
  // sont pas des frais connus (le coût d'achat serait sous-estimé). Au tribunal, les défauts restent admis.
  const fees = input.fees ?? null;
  const feesDefault =
    fees != null &&
    (fees.preliminary === "defaut" ||
      fees.negotiation === "defaut" ||
      fees.advertising === "defaut");
  if (thresholds.corrected && !court && fees != null) {
    check("fees_known", fees.negotiation !== "defaut" && fees.advertising !== "defaut");
  }
  // pepite-v1.1 : sous 30 % de la valeur, l'écart se confond souvent avec une erreur de valeur ; seule une
  // estimation de fiabilité « forte » l'admet.
  if (thresholds.corrected && start != null && central != null) {
    if (start / central < PEPITE_LOW_STARTING_PRICE_SHARE) {
      check("low_start_strong_estimate", estimate?.reliability === "forte");
    }
  }
  const { capabilities } = thresholds;
  // pepite-v1.2 : un très grand bien ou une très forte valeur sort du périmètre où l'estimation est fiable. Une
  // surface inconnue ne l'écarte pas ici (`surface_known` et `estimate_actionable` s'en chargent).
  const habitableSurface = positive(input.habitableSurfaceM2);
  if (capabilities.sizeValueCap) {
    check(
      "size_value_supported",
      !(habitableSurface != null && habitableSurface > PEPITE_MAX_HABITABLE_SURFACE_M2) &&
        !(central != null && central > PEPITE_MAX_CENTRAL_VALUE_EUR),
    );
  }
  // pepite-v1.2 : marché local. Pas d'agrégat = pas d'exclusion (voir `evaluateLocalMarket`).
  const localMarket = capabilities.localMarket ? evaluateLocalMarket(input.market) : null;
  if (localMarket) {
    check("market_liquid", localMarket.liquid);
    check("market_not_declining", localMarket.notDeclining);
  }

  // Signaux bloquants.
  check("no_valuation_conflict", !signals.valuationConflict);
  check("no_ai_block", !signals.aiBlocked);
  check("no_degraded_condition", !signals.degradedCondition);
  check("verification_not_conflict", !signals.verificationConflict);
  check("no_probable_duplicate", !signals.probableDuplicate);
  check("risks_qualified", !signals.unqualifiedRisks);
  if (capabilities.coproDistress) check("no_copro_distress", signals.coproDistress !== true);

  // Inondation (pepite-v2). Le verdict inconnu (position imprécise dans une commune qui a un TRI, source
  // indisponible) ne passe pas à l'entrée mais est toléré au maintien ; `no_high_flood_risk` n'est évalué que
  // si le verdict est connu, et seul un risque ÉLEVÉ le manque.
  if (thresholds.flood !== "off") {
    const verdict = input.flood.verdict;
    const known = verdict !== "unknown";
    // « Aucun risque élevé identifié » sans lecture du périmètre des PPRi n'est qu'un demi-contrôle : il ne fait
    // pas entrer une nouvelle pépite (au maintien, il est toléré, comme un verdict inconnu).
    const fullyChecked = verdict !== "none_found" || input.flood.ppriChecked;
    if (thresholds.flood === "entry") check("flood_risk_known", known && fullyChecked);
    if (known) check("no_high_flood_risk", verdict !== "high");
  }

  const metrics: PepiteMetrics = {
    ...EMPTY_METRICS,
    startingPriceEur: start,
    centralValueEur: central,
    lowValueEur: low,
    referenceCeilingEur: reference,
    startingShareOfValue: start != null && central != null ? start / central : null,
    feesDefault,
  };
  const occupancyDiscountPct = thresholds.corrected
    ? Math.min(50, Math.max(0, input.occupancyDiscountPct ?? 0))
    : 0;
  if (thresholds.corrected) metrics.occupancyDiscountPct = occupancyDiscountPct;
  // pepite-v1.2 : coût de rénovation énergétique. DPE inconnu : aucun ajout, `dpeClass: null` le signale.
  let energyRenovationEur: number | null = null;
  if (capabilities.energyCost) {
    const dpeClass = input.energy?.dpeClass ?? null;
    energyRenovationEur = energyRenovationCostEur(dpeClass, habitableSurface);
    metrics.dpeClass = dpeClass;
    metrics.dpeSource = dpeClass ? (input.energy?.dpeSource ?? null) : null;
    metrics.energyRenovationEur = energyRenovationEur;
    metrics.habitableSurfaceM2 = habitableSurface;
  } else if (capabilities.sizeValueCap) {
    metrics.habitableSurfaceM2 = habitableSurface;
  }
  if (localMarket) metrics.market = localMarket.metrics;

  // Prix probable : mise à prix × multiplicateur local (tribunal) ; la mise à prix elle-même, ou la
  // première offre possible, pour une vente notariale (aucun historique en base).
  if (start != null && central != null) {
    if (court) {
      if (scenariosUsable && quartiles) {
        const lowStart = start < PEPITE_LOW_STARTING_PRICE_SHARE * central;
        const multiplier = (lowStart ? quartiles.q75 : quartiles.q50) as number;
        metrics.multiplierKey = lowStart ? "q75" : "q50";
        metrics.multiplier = multiplier;
        metrics.probablePriceEur = start * multiplier;
        metrics.rangeLowEur = start * (quartiles.q25 as number);
        metrics.rangeHighEur = start * (quartiles.q75 as number);
      }
    } else {
      metrics.multiplierKey = "start";
      metrics.multiplier = 1;
      metrics.probablePriceEur = start;
    }
  }

  // Test B (tribunal) : la part des ventes comparables adjugées sous le plafond de référence.
  if (court && start != null && reference != null && scenariosUsable && scenarios) {
    const position = ceilingPosition(scenarios.buckets, reference, start);
    if (position?.kind === "share") {
      metrics.chanceShare = position.share;
      metrics.chanceAtLeast = position.atLeast;
      const sample = chanceSampleSize(scenarios.courtSample, scenarios.nationalSample);
      const wilsonLow = Number.isFinite(position.share)
        ? wilsonLowerBound(position.share, sample)
        : null;
      if (thresholds.corrected) {
        metrics.chanceSample = sample;
        metrics.chanceWilsonLow = wilsonLow;
      }
      if (thresholds.corrected) {
        // Un plancher (« au moins », au-delà de 3 fois la mise à prix) est une part ÉTABLIE au moins égale à
        // `position.share` : il réussit le test seulement s'il atteint le seuil, comme une part exacte. À
        // l'entrée, l'effectif doit aussi porter la part (borne basse de Wilson).
        check(
          "test_b_chance",
          Number.isFinite(position.share) &&
            position.share >= thresholds.chanceMinShare &&
            (thresholds.chanceMinWilsonLow == null ||
              (wilsonLow != null && wilsonLow >= thresholds.chanceMinWilsonLow)),
        );
      } else {
        // pepite-v1 (figée) : un plancher réussit le test quelle que soit la part.
        check(
          "test_b_chance",
          Number.isFinite(position.share) &&
            (position.atLeast || position.share >= thresholds.chanceMinShare),
        );
      }
    } else {
      // Plafond sous la mise à prix (ou sans tranche exploitable) : aucune enchère ne tient.
      metrics.ceilingBelowStart = position?.kind === "below_start" || reference <= 0;
      check("test_b_chance", false);
    }
  }

  // Test C : coût total au prix probable, rapporté à la valeur centrale.
  if (ceiling && central != null && metrics.probablePriceEur != null && reference != null) {
    const purchaseCost = ceiling.totalCostAt(metrics.probablePriceEur);
    // pepite-v1.2 : la rénovation énergétique (DPE F ou G) s'ajoute au coût total ; DPE inconnu : rien.
    const total =
      purchaseCost != null && Number.isFinite(purchaseCost)
        ? purchaseCost + (energyRenovationEur ?? 0)
        : purchaseCost;
    if (total != null && Number.isFinite(total)) {
      metrics.totalCostEur = total;
      // pepite-v1.1 : la valeur centrale est celle d'un bien libre ; un bien loué se négocie moins cher.
      metrics.costRatio = total / (central * (1 - occupancyDiscountPct / 100));
      check("test_c_cost", metrics.costRatio <= thresholds.costMaxShare);
    } else {
      // Coût illisible : le test est manqué (jamais réussi par défaut).
      check("test_c_cost", false);
    }
  }

  // Vente à la bougie : le plafond de référence doit couvrir la mise à prix.
  if (regime === "notary_auction" && start != null && reference != null) {
    check("ceiling_above_start", reference >= start);
  }

  return { passed, missed, metrics, dataMissing };
}

const sortByCatalogue = (ids: PepiteCriterionId[]) =>
  [...ids].sort((left, right) => PEPITE_CRITERIA.indexOf(left) - PEPITE_CRITERIA.indexOf(right));

/**
 * Évalue une vente avec la règle de la version donnée (`PEPITE_RULE_CAPABILITIES` dit ce que chacune évalue), à cet
 * instant et sans mémoire : la stabilité (deux évaluations favorables, hystérésis, gel) est appliquée ensuite par
 * `applyPepiteStability`. La version est OBLIGATOIRE : aucun appelant ne peut contourner l'interrupteur
 * `PEPITE_RULE_V2_ENABLED` en l'oubliant.
 *
 *  - ventes couvertes : tribunal, vente notariale à la bougie et vente notariale interactive, quand
 *    le régime est ouvert (`openFeeRegimesFromEnv`) ; rien pour les autres ;
 *  - tribunal : tests B et C ; bougie et interactive : test C seul, au seuil de 65 % (la bougie exige
 *    aussi un plafond de référence au moins égal à la mise à prix) ;
 *  - un signal bloquant donne « pas une pépite », même si une donnée manque ; sinon une donnée
 *    indispensable manquante donne « données insuffisantes » ;
 *  - inondation (v2) : `no_high_flood_risk` est bloquant (un risque élevé fait sortir même une pépite figée à
 *    J-7) ; `flood_risk_known` manque à l'entrée quand le verdict est inconnu (aucune nouvelle pépite) mais
 *    n'est pas exigé au maintien (une pépite publiée reste affichée) ; il manque aussi à l'entrée quand « aucun
 *    risque élevé » ne repose que sur les TRI (périmètre des PPRi non lu) ; un verdict inconnu n'est PAS une donnée
 *    manquante (pas de sortie par délai de grâce). La v2 ne rend jamais favorable ce que la v1 refusait ;
 *  - pepite-v1.2 et v2.1 : le coût de rénovation énergétique s'ajoute au coût du test C ; `size_value_supported`,
 *    `market_liquid` et `market_not_declining` sont éliminatoires mais non bloquants (ils ne jouent qu'aux
 *    recalculs normaux) ; `no_copro_distress` est bloquant. Les badges (`pepite-badges.ts`) n'entrent pas ici.
 */
export function evaluatePepite(
  input: PepiteInput,
  ruleVersion: PepiteRuleVersion,
): PepiteEvaluation {
  const regime = input.regime;
  const base = { ruleVersion, regime };
  const capabilities = pepiteRuleCapabilities(ruleVersion);
  const { corrected, flood } = capabilities;

  const eligibility: PepiteCriterionId[] = [];
  const ineligible: PepiteCriterionId[] = [];
  (regime != null ? eligibility : ineligible).push("regime_open");
  (input.upcoming ? eligibility : ineligible).push("sale_upcoming");
  if (regime == null || ineligible.length > 0) {
    return {
      ...base,
      status: "not_applicable",
      favorable: false,
      frozenQualityMissed: false,
      holds: false,
      blocking: false,
      passed: eligibility,
      missed: ineligible,
      holdMissed: ineligible,
      metrics: { ...EMPTY_METRICS },
    };
  }

  const entry = runCriteria(input, regime, {
    capabilities,
    chanceMinShare: PEPITE_CHANCE_MIN_SHARE,
    chanceMinWilsonLow: corrected ? PEPITE_CHANCE_MIN_WILSON_LOW : null,
    costMaxShare: entryCostMaxShare(regime),
    flood: flood ? "entry" : "off",
    corrected,
  });
  const exit = runCriteria(input, regime, {
    capabilities,
    chanceMinShare: PEPITE_CHANCE_EXIT_SHARE,
    // Au maintien, la part seule compte : une pépite dont l'effectif est mince reste « à confirmer ».
    chanceMinWilsonLow: null,
    costMaxShare: exitCostMaxShare(regime),
    flood: flood ? "hold" : "off",
    corrected,
  });

  const missed = sortByCatalogue(entry.missed);
  const blocking = missed.some((id) => PEPITE_BLOCKING_CRITERIA.includes(id));
  const dataMissing = entry.dataMissing;
  const status: PepiteStatus = blocking
    ? "not_pepite"
    : dataMissing
      ? "insufficient"
      : missed.length === 0
        ? "pepite"
        : "not_pepite";

  return {
    ...base,
    status,
    favorable: status === "pepite",
    frozenQualityMissed:
      corrected && missed.some((id) => PEPITE_FREEZE_QUALITY_CRITERIA.includes(id)),
    holds: exit.missed.length === 0,
    blocking,
    passed: sortByCatalogue([...eligibility, ...entry.passed]),
    missed,
    holdMissed: sortByCatalogue(exit.missed),
    metrics: entry.metrics,
  };
}

/** Ce que le traitement planifié a stocké de la dernière évaluation de la vente. */
export type PepiteStoredState = {
  isPepite: boolean;
  favorableStreak: number;
  frozenAt: string | null;
  /** Date de la dernière évaluation favorable COMPTÉE dans la série (ISO) : sert à l'espacement. */
  lastFavorableAt: string | null;
  /** Depuis quand une pépite publiée n'a plus de donnée pour être évaluée (ISO) ; nul sinon. */
  dataMissingSince: string | null;
  /** Mise à prix lue lors de la dernière évaluation. */
  inputStartingPriceEur: number | null;
  /** Version de la règle qui a produit cet état : une version différente de celle appliquée lève le gel (J-7). */
  ruleVersion?: string | null;
};

export type PepiteStability = {
  /** Résultat publiable : après deux évaluations favorables, avec hystérésis et gel. */
  isPepite: boolean;
  favorableStreak: number;
  frozenAt: string | null;
  lastFavorableAt: string | null;
  dataMissingSince: string | null;
  /** Codes de motif de la stabilité (préfixe `stab:`). */
  codes: string[];
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function timestamp(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const RESET: Omit<PepiteStability, "codes"> = {
  isPepite: false,
  favorableStreak: 0,
  frozenAt: null,
  lastFavorableAt: null,
  dataMissingSince: null,
};

/**
 * Stabilité du résultat, appliquée par le traitement planifié à partir de l'état stocké :
 *  - entrée après `PEPITE_FAVOURABLE_EVALUATIONS` évaluations favorables consécutives, la suivante n'étant
 *    comptée que si elle est espacée d'au moins `PEPITE_MIN_HOURS_BETWEEN_EVALUATIONS` heures de la
 *    dernière évaluation COMPTÉE (`lastFavorableAt`), pas de la dernière évaluation tout court : une
 *    évaluation non favorable remet la série à zéro, la suivante compte aussitôt ;
 *  - sortie quand la vente ne tient plus aux seuils de sortie (part B sous 65 %, ratio C au-delà de
 *    80 % au tribunal et 70 % en vente notariale, garde-fou manqué), ou dès qu'un signal bloquant
 *    apparaît (immédiat, même figée) ;
 *  - donnée manquante (statut « insuffisant ») : une pépite publiée est tolérée `PEPITE_DATA_GRACE_HOURS`
 *    heures sans changer, puis sort ;
 *  - gel à `PEPITE_FREEZE_DAYS` jours de la vente : le résultat ne change plus, sauf signal
 *    bloquant, changement de prix, changement de version de la règle (réévaluée une fois, aux seuils de sortie)
 *    ou (pepite-v1.1 et suivantes) porte de qualité de l'estimation manquée ;
 *    le traitement planifié ne réécrit pas non plus les détails de l'évaluation publiée (`sale-pepites-batch.ts`).
 * `previous` : l'état stocké, quelle que soit la version de la règle, du moteur ou du régime : un
 * changement de version ne remet rien à zéro, la vente est réévaluée tout de suite et une pépite publiée
 * ne reste publiée que si la nouvelle évaluation passe les seuils de sortie.
 */
export function applyPepiteStability({
  previous,
  evaluation,
  startingPriceEur,
  saleDate,
  now,
}: {
  previous: PepiteStoredState | null;
  evaluation: PepiteEvaluation;
  startingPriceEur: number | null;
  saleDate: Date | string | null;
  now: Date;
}): PepiteStability {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  if (evaluation.status === "not_applicable") return { ...RESET, codes: [] };
  if (evaluation.blocking) {
    return { ...RESET, codes: previous?.isPepite ? ["stab:exit_blocking"] : [] };
  }

  const priceChanged =
    previous != null &&
    previous.inputStartingPriceEur != null &&
    startingPriceEur != null &&
    previous.inputStartingPriceEur !== startingPriceEur;
  const saleMs = timestamp(saleDate);
  const frozenWindow =
    saleMs != null && saleMs > nowMs && saleMs - nowMs <= PEPITE_FREEZE_DAYS * DAY_MS;
  // Une évaluation stockée sous une autre version de la règle ne reste pas gelée : ses motifs et ses détails seraient
  // ceux de l'ancienne règle sous l'étiquette de la nouvelle. Elle est réévaluée une fois, aux seuils de sortie.
  const ruleChanged =
    previous?.ruleVersion != null && previous.ruleVersion !== evaluation.ruleVersion;
  if (frozenWindow && previous && !priceChanged && !ruleChanged) {
    // pepite-v1.1 : une porte de qualité de l'estimation manquée est bloquante pendant le gel.
    if (evaluation.frozenQualityMissed && previous.isPepite) {
      return { ...RESET, codes: ["stab:exit_quality"] };
    }
    return {
      isPepite: previous.isPepite,
      favorableStreak: previous.favorableStreak,
      frozenAt: previous.frozenAt ?? nowIso,
      lastFavorableAt: previous.lastFavorableAt,
      dataMissingSince: previous.dataMissingSince,
      codes: ["stab:frozen"],
    };
  }
  const codes = priceChanged && frozenWindow ? ["stab:price_changed"] : [];

  // Déjà publiée : elle reste tant qu'elle tient aux seuils de sortie.
  if (previous?.isPepite) {
    if (evaluation.status === "insufficient") {
      // Donnée manquante : on ne peut pas juger. Tolérée un temps, sans changer, puis elle sort.
      const sinceMs = timestamp(previous.dataMissingSince) ?? nowMs;
      if (nowMs - sinceMs >= PEPITE_DATA_GRACE_HOURS * HOUR_MS) {
        return { ...RESET, codes: [...codes, "stab:exit_data_missing"] };
      }
      return {
        isPepite: true,
        favorableStreak: Math.max(previous.favorableStreak, PEPITE_FAVOURABLE_EVALUATIONS),
        frozenAt: null,
        lastFavorableAt: previous.lastFavorableAt,
        dataMissingSince: new Date(sinceMs).toISOString(),
        codes: [...codes, "stab:data_missing"],
      };
    }
    if (evaluation.holds) {
      return {
        isPepite: true,
        favorableStreak: Math.max(previous.favorableStreak, PEPITE_FAVOURABLE_EVALUATIONS),
        frozenAt: null,
        lastFavorableAt: previous.lastFavorableAt,
        dataMissingSince: null,
        codes,
      };
    }
    return { ...RESET, codes: [...codes, "stab:exit"] };
  }

  // Pas encore publiée : il faut des évaluations favorables consécutives.
  if (!evaluation.favorable) return { ...RESET, codes };
  const lastMs = timestamp(previous?.lastFavorableAt);
  const distinct =
    previous == null ||
    previous.favorableStreak === 0 ||
    lastMs == null ||
    nowMs - lastMs >= PEPITE_MIN_HOURS_BETWEEN_EVALUATIONS * HOUR_MS;
  const streak = (previous?.favorableStreak ?? 0) + (distinct ? 1 : 0);
  const entered = streak >= PEPITE_FAVOURABLE_EVALUATIONS;
  return {
    isPepite: entered,
    favorableStreak: Math.min(streak, PEPITE_FAVOURABLE_EVALUATIONS),
    frozenAt: null,
    lastFavorableAt: distinct ? nowIso : (previous?.lastFavorableAt ?? nowIso),
    dataMissingSince: null,
    codes: [...codes, entered ? "stab:entered" : `stab:streak_${streak}`],
  };
}

/** Les codes de motif stockés : un par critère évalué, plus ceux de la stabilité. */
export function pepiteReasonCodes(evaluation: PepiteEvaluation, stability?: PepiteStability) {
  return [
    ...evaluation.passed.map((id) => `pass:${id}`),
    ...evaluation.missed.map((id) => `fail:${id}`),
    ...(stability?.codes ?? []),
  ];
}
