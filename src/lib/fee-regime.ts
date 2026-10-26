// Régime de frais d'une vente : quelles règles de frais et quel vocabulaire le calcul de l'enchère
// plafond applique, et si son calcul est ouvert pour ce type de vente. Les règles elles-mêmes sont
// dans `fee-regime-definitions.ts` (importé par le moteur) et le vocabulaire dans `fee-regime-labels.ts` ; ce module y ajoute le lien avec
// une vente (`getSaleProcedure`) et l'interrupteur par régime. Module pur, sans import serveur.
import { FEE_REGIMES, type FeeRegime } from "@/lib/fee-regime-definitions";
import {
  DEFAULT_OPEN_FEE_REGIMES,
  FEE_REGIME_KEYS,
  feeRegimeKeyForVenue,
  type FeeRegimeKey,
} from "@/lib/fee-regime-open";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";

export * from "@/lib/fee-regime-definitions";
export * from "@/lib/fee-regime-labels";
export * from "@/lib/fee-regime-open";

/**
 * Le régime de frais de la vente, quand son calcul est ouvert ; `null` sinon (« pas de plafond »).
 * Aujourd'hui seule une vente au tribunal a un régime (même condition que `saleIsTribunalVenue`) :
 * les ventes notariales et domaniales n'en ont pas, tant que leurs règles ne sont pas définies.
 * `open` : les régimes ouverts (voir `parseOpenFeeRegimes`) ; le tribunal est toujours ouvert.
 */
export function feeRegimeForSale(
  sale: AuctionSale,
  open: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): FeeRegime | null {
  const key = feeRegimeKeyForVenue(getSaleProcedure(sale).venueType, open);
  return key != null ? (FEE_REGIMES[key] ?? null) : null;
}

/**
 * Interrupteur par régime, sur le modèle de `ADJUDICATION_PRICE_STATISTICS_ENABLED` : la valeur de
 * `CEILING_FEE_REGIMES_OPEN` (clés séparées par des virgules, par exemple
 * `notary_auction,notary_online`). Le tribunal est toujours ouvert ; une clé inconnue est ignorée,
 * et une clé sans règles définies n'ouvre rien (voir `isFeeRegimeOpen`). Lu côté serveur et passé
 * en prop aux composants.
 */
export function parseOpenFeeRegimes(value: string | null | undefined): FeeRegimeKey[] {
  const requested = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is FeeRegimeKey => (FEE_REGIME_KEYS as readonly string[]).includes(item));
  return [...new Set<FeeRegimeKey>(["tribunal", ...requested])];
}
