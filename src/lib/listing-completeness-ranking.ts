import type { AuctionSale } from "./types";

/**
 * Règle unique du classement par complétude de /sales.
 *
 * Le critère est le score de complétude de la fiche (`getListingCompleteness`, 0 à 100), jamais le
 * score interne `premium_readiness_*`. Deux paliers seulement :
 *   - palier haut (1) : score de complétude >= `highTierMinScore` (40 sur 100). Le score seul
 *     décide: ni la classification publiée de la fiche ni ses portes critiques n'interviennent ;
 *   - palier bas (0) : tout le reste, y compris une vente pas encore évaluée (on ne met pas en
 *     avant ce qui n'est pas mesuré) et un score absent ou invalide.
 * Le score numérique est stocké à côté du palier pour la mesure, mais ne sort jamais de la base.
 *
 * Historique: la version v1 retenait les classifications « décision prête » et « riche » (score
 * >= 75, portes critiques comprises). La première mesure en production (1 917 ventes, score médian
 * 36, maximum 71) n'en plaçait aucune au palier haut. Décision du propriétaire du 14/10/2026: seuil
 * à 40, soit 714 ventes (37 %) de sources variées.
 *
 * Pour recalibrer après une mesure en production, changer le seuil ET incrémenter `version` : la
 * tâche planifiée réévalue alors toutes les ventes dont la version stockée diffère. Le texte
 * d'explication affiché aux utilisateurs (`RANKING_EXPLANATION_STEPS`) cite ce seuil.
 */
export const LISTING_COMPLETENESS_POLICY = {
  version: "completeness-tier-v2",
  highTierMinScore: 40,
} as const;

export const COMPLETENESS_TIER_LOW = 0;
export const COMPLETENESS_TIER_HIGH = 1;

export type CompletenessTier = typeof COMPLETENESS_TIER_LOW | typeof COMPLETENESS_TIER_HIGH;

/**
 * Palier d'une fiche à partir de son score de complétude (0-100) ; score absent, non fini ou
 * hors de l'échelle: palier bas.
 */
export function completenessTierForScore(score: number | null | undefined): CompletenessTier {
  return typeof score === "number" &&
    Number.isFinite(score) &&
    score <= 100 &&
    score >= LISTING_COMPLETENESS_POLICY.highTierMinScore
    ? COMPLETENESS_TIER_HIGH
    : COMPLETENESS_TIER_LOW;
}

/** Vrai pour une annonce du palier haut (badge « Annonce bien renseignée »). */
export function isWellInformedSale(sale: Pick<AuctionSale, "completeness_tier">): boolean {
  return sale.completeness_tier === COMPLETENESS_TIER_HIGH;
}
