// Le calcul de l'enchère plafond d'une vente, de la vente brute au plan : une seule chaîne, partagée
// par la fiche, le rapport enregistré et tout futur traitement serveur, pour que ces écrans ne
// puissent pas afficher deux montants différents. Module pur : ni accès aux données ni import
// serveur (il est embarqué dans le lot de la fiche).
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import {
  computeCeilingPlan,
  type CeilingHypotheses,
  type CeilingPlan,
} from "@/lib/bid-ceiling-engine";
import {
  AI_REVIEW_SURFACE_FIELD_KEYS,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { saleForAiReviewDisplay } from "@/lib/ai-review-display";
import { feeRegimeForSale, type FeeRegime, type FeeRegimeKey } from "@/lib/fee-regime";
import { listingValuationConflict } from "@/lib/listing-evidence";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

type SaleCeilingSource = {
  sale: AuctionSale;
  /** Relecture IA de la vente (`null` : pas lue). */
  aiProjections: readonly AiReviewProjectionReadModel[] | null;
  /** État de la lecture de la relecture IA (voir `getAiReviewFieldResult`). */
  aiReviewStatus: AiReviewRequestStatus;
  /** Régimes de frais ouverts ; absent : tous ceux dont les règles sont définies (voir `parseOpenFeeRegimes`). */
  regimes?: readonly FeeRegimeKey[];
};

/** Ce qui décide, avant tout calcul, si un plafond peut être chiffré pour la vente. */
export type SaleCeilingInputs = {
  /** Régime de frais de la vente quand son calcul est ouvert ; `null` : pas de plafond. */
  regime: FeeRegime | null;
  /** La vente avec les champs que la relecture IA bloque effacés. */
  displaySale: AuctionSale;
  /** Contradiction entre les données de la vente qui suspend l'estimation, sinon `null`. */
  valuationConflict: string | null;
  /** Champs de la relecture IA bloqués, un par donnée dont le plafond dépend. */
  blocked: {
    price: boolean;
    surface: boolean;
    propertyType: boolean;
    rooms: boolean;
    /** L'un des quatre : le plafond n'est pas calculé. */
    critical: boolean;
  };
  /** Surface retenue pour la valeur ; `null` quand un champ critique est bloqué. */
  surface: number | null;
};

export type SaleCeiling = SaleCeilingInputs & {
  /** Le plafond est calculé : vente ouverte, régime ouvert, aucun conflit ni champ critique bloqué. */
  enabled: boolean;
  hypotheses: CeilingHypotheses;
  plan: CeilingPlan;
};

/**
 * Les gardes qui précèdent le calcul : conflit de valorisation, champs critiques bloqués par la
 * relecture IA, surface et régime de frais. La fiche en a besoin avant de demander l'estimation de
 * marché, d'où cette fonction séparée de `computeSaleCeiling`.
 */
export function assessSaleCeilingInputs({
  sale,
  aiProjections,
  aiReviewStatus,
  regimes,
}: SaleCeilingSource): SaleCeilingInputs {
  const displaySale = saleForAiReviewDisplay(sale, aiProjections, aiReviewStatus);
  const review = (fieldKey: Parameters<typeof getAiReviewFieldResult>[1]) =>
    getAiReviewFieldResult(aiProjections, fieldKey, aiReviewStatus).blocked;
  const price = review("sale.starting_price_eur");
  const surfaceBlocked = AI_REVIEW_SURFACE_FIELD_KEYS.some((fieldKey) => review(fieldKey));
  const propertyType = review("property.property_type");
  const rooms = review("property.rooms_count");
  const critical = price || surfaceBlocked || propertyType || rooms;
  return {
    regime: feeRegimeForSale(sale, regimes),
    displaySale,
    valuationConflict: listingValuationConflict(sale),
    blocked: { price, surface: surfaceBlocked, propertyType, rooms, critical },
    surface: critical ? null : getMarketValuationSurfaces(displaySale).builtSurfaceM2,
  };
}

/**
 * Hypothèses et plan de l'enchère plafond d'une vente.
 *
 * `estimate` : l'estimation de marché que l'appelant a le droit de lire (la fiche applique ses droits
 * d'accès avant) ; elle est ignorée quand le plafond est bloqué. `choices` : les choix de
 * l'utilisateur, tels quels (la fiche y met le budget travaux retenu).
 *
 * `fullData` : la vente est lue en entier (faux pour le compte gratuit qui n'a rien débloqué).
 * `guarded: false` : l'appelant a déjà décidé si le plafond a lieu d'être (le rapport enregistré) :
 * ni régime, ni conflit, ni blocage IA n'empêchent alors le calcul, qui reste celui du régime de la
 * vente, ou du tribunal à défaut.
 * `assessed` : le résultat de `assessSaleCeilingInputs`, quand l'appelant l'a déjà ; la vente, la
 * relecture IA et les régimes ne sont alors pas nécessaires.
 */
export function computeSaleCeiling({
  estimate,
  choices = {},
  fullData = true,
  guarded = true,
  ...rest
}: ({ assessed: SaleCeilingInputs } | (SaleCeilingSource & { assessed?: undefined })) & {
  estimate: CeilingMarketEstimate | null;
  choices?: CeilingUserChoices;
  fullData?: boolean;
  guarded?: boolean;
}): SaleCeiling {
  const inputs = rest.assessed ?? assessSaleCeilingInputs(rest);
  const enabled = guarded
    ? fullData && inputs.regime != null && !inputs.valuationConflict && !inputs.blocked.critical
    : true;
  const built = buildCeilingHypotheses(
    inputs.displaySale,
    enabled ? estimate : null,
    choices,
    inputs.regime,
  );
  // Gardé : la surface retenue (`null` quand un champ critique est bloqué) prime. Non gardé : celle
  // des hypothèses, lue sur la vente telle quelle.
  const hypotheses = guarded ? { ...built, surface: enabled ? inputs.surface : null } : built;
  return { ...inputs, enabled, hypotheses, plan: computeCeilingPlan(hypotheses) };
}
