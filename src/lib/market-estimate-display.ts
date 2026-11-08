import { passesPublicMarketGapGate } from "@/lib/market-gap-band";
import type { MarketEstimate } from "@/lib/market-server/types";

/**
 * Ce que la fiche peut dire d'une estimation de marché, et avec quels mots.
 *
 * Le montant ponctuel (« Valeur estimée à 230 000 € ») n'est montré que pour une estimation qui passe
 * la porte publique (`passesPublicMarketGapGate`, 6 ou 8 comparables, effectif 5, largeur ≤ 60 %),
 * plus exigeante que `actionable` (4 comparables, effectif 3) ; sinon la fourchette seule.
 */
export function passesPublicEstimateGate(estimate: MarketEstimate): boolean {
  return passesPublicMarketGapGate({
    actionable: estimate.actionable,
    comparableCount: estimate.sampleSize,
    effectiveSampleSize: estimate.effectiveSampleSize,
    intervalMethod: estimate.predictionInterval?.method,
    // Les mêmes montants que la base (`value_p10_eur`, `value_p50_eur`, `value_p90_eur`).
    p10: estimate.estimatedValueLowEur,
    p50: estimate.estimatedValueEur,
    p90: estimate.estimatedValueHighEur,
    radiusM: estimate.radiusM,
    segment: estimate.segment,
    areaKind: estimate.areaKind,
  });
}

/**
 * D'où vient la valeur : « d’après 12 ventes comparables », ou, quand un modèle LightGBM entre dans
 * le mélange, « d’après des ventes comparables et un modèle statistique ». Jamais un effectif décimal.
 */
export function estimateSourceNote(estimate: {
  engineKind?: MarketEstimate["engineKind"];
  sampleSize?: number | null;
}): string {
  if (estimate.engineKind === "hybrid_lightgbm") {
    return "d’après des ventes comparables et un modèle statistique";
  }
  const count = estimate.sampleSize;
  if (count == null || !Number.isInteger(count) || count <= 0) {
    return "d’après des ventes comparables";
  }
  return `d’après ${count} vente${count > 1 ? "s" : ""} comparable${count > 1 ? "s" : ""}`;
}

/**
 * La médiane des ventes comparables, seule à pouvoir se dire « observée ». En mode hybride,
 * `medianPricePerM2` est le p50 du mélange : une estimation calculée avant que la médiane des
 * comparables soit gardée n'en a donc pas (`null`).
 */
export function observedMedianPricePerM2(estimate: MarketEstimate): number | null {
  if (estimate.comparableMedianPricePerM2 != null) return estimate.comparableMedianPricePerM2;
  return estimate.engineKind === "hybrid_lightgbm" ? null : estimate.medianPricePerM2;
}
