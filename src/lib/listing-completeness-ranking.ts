import type { CompletenessClass } from "./listing-completeness/catalogue";
import type { AuctionSale } from "./types";

/**
 * Règle unique du classement par complétude de /sales.
 *
 * Le critère est la classification PUBLIÉE de la fiche (`getListingCompleteness`), portes
 * critiques comprises, jamais le score interne `premium_readiness_*`. Deux paliers seulement :
 *   - palier haut (1) : la fiche est « décision prête » ou « riche » (score >= 75 et aucune porte
 *     d'identité ou critique en échec) : le badge ne contredit donc jamais ce que la fiche affiche ;
 *   - palier bas (0) : tout le reste, y compris une vente pas encore évaluée (on ne met pas en
 *     avant ce qui n'est pas mesuré).
 * Le score numérique est stocké à côté du palier pour la mesure, mais ne sort jamais de la base.
 *
 * Pour recalibrer après une mesure en production, changer les classifications retenues ET
 * incrémenter `version` : la tâche planifiée réévalue alors toutes les ventes dont la version
 * stockée diffère. Le texte d'explication affiché aux utilisateurs (`RANKING_EXPLANATION_TEXT`)
 * décrit ce classement.
 */
export const LISTING_COMPLETENESS_POLICY = {
  version: "completeness-tier-v1",
  highTierClassifications: ["decision_prete", "riche"],
} as const satisfies { version: string; highTierClassifications: readonly CompletenessClass[] };

export const COMPLETENESS_TIER_LOW = 0;
export const COMPLETENESS_TIER_HIGH = 1;

export type CompletenessTier = typeof COMPLETENESS_TIER_LOW | typeof COMPLETENESS_TIER_HIGH;

/** Palier d'une fiche à partir de sa classification publiée ; absente ou inconnue : palier bas. */
export function completenessTierForClassification(
  classification: CompletenessClass | null | undefined,
): CompletenessTier {
  return classification &&
    (LISTING_COMPLETENESS_POLICY.highTierClassifications as readonly string[]).includes(
      classification,
    )
    ? COMPLETENESS_TIER_HIGH
    : COMPLETENESS_TIER_LOW;
}

/** Vrai pour une annonce du palier haut (badge « Annonce bien renseignée »). */
export function isWellInformedSale(sale: Pick<AuctionSale, "completeness_tier">): boolean {
  return sale.completeness_tier === COMPLETENESS_TIER_HIGH;
}
