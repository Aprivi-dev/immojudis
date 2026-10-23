import { MARKET_WIDEN_UNTIL_COMPARABLES } from "@/lib/market-comparable-minimums";
import { marketGapBandMaxRadiusM } from "@/lib/market-gap-band";

/**
 * Faut-il essayer le rayon suivant ?
 *
 * - Estimation non exploitable : oui, jusqu'au dernier rayon de la liste (comportement historique).
 * - Estimation exploitable mais sous l'effectif exigé par la porte publique (6 comparables, voir
 *   `market-comparable-minimums.ts`) : oui, tant que le rayon suivant reste dans le rayon maximal
 *   que cette porte accepte pour ce type de bien. Au-delà, élargir ne ferait que rendre
 *   l'estimation moins locale sans pouvoir franchir la porte.
 * - Sinon : non.
 */
export function shouldWidenRadius(input: {
  actionable: boolean;
  sampleSize: number;
  nextRadiusM: number;
  segment: string;
  areaKind: "urban" | "rural";
}): boolean {
  if (!input.actionable) return true;
  if (input.sampleSize >= MARKET_WIDEN_UNTIL_COMPARABLES) return false;
  return input.nextRadiusM <= marketGapBandMaxRadiusM(input.segment, input.areaKind);
}
