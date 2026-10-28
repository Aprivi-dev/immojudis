// Clé du régime de frais d'une vente (tribunal, bougie, vente interactive), SANS les règles ni les textes :
// module léger que le rendement brut (`sale-yield-fees.ts`, lu par les filtres du navigateur) importe sans
// embarquer les barèmes notariaux ni le vocabulaire. `fee-regime.ts` le réexporte.
import {
  DEFAULT_OPEN_FEE_REGIMES,
  feeRegimeKeysForVenue,
  type FeeRegimeKey,
} from "@/lib/fee-regime-open";
import { notarySaleMode, readNotarySaleConditions } from "@/lib/notary-sale-conditions";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale, SaleLegalFramework } from "@/lib/types";

/** Cadres judiciaires : le barème de l'adjudication volontaire des notaires ne s'y applique pas. */
const JUDICIAL_FRAMEWORKS: readonly SaleLegalFramework[] = [
  "judicial_seizure",
  "judicial_partition",
  "insolvency",
];

/**
 * La clé du régime de frais de la vente, quand son calcul est ouvert ; `null` sinon (« pas de
 * plafond »).
 *  - Une vente au tribunal a le régime tribunal.
 *  - Une vente notariale a celui de la bougie ou de la vente interactive, selon ce que le pipeline a
 *    écrit dans ses conditions (`notarySaleMode`). Mode inconnu (conditions non lisibles par ce
 *    compte, mentions contradictoires), vente d'origine judiciaire (licitation, saisie) : `null`.
 *  - Les ventes domaniales et les types inconnus n'en ont pas.
 * `open` : les régimes ouverts (voir `parseOpenFeeRegimes`) ; le tribunal est toujours ouvert.
 */
export function feeRegimeKeyForSale(
  sale: AuctionSale,
  open: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): FeeRegimeKey | null {
  const procedure = getSaleProcedure(sale);
  const possible = feeRegimeKeysForVenue(procedure.venueType, open);
  if (possible.length === 0) return null;
  if (procedure.venueType === "tribunal") return possible[0];
  if (JUDICIAL_FRAMEWORKS.includes(procedure.legalFramework)) return null;
  const mode = notarySaleMode(readNotarySaleConditions(sale));
  const key: FeeRegimeKey | null =
    mode === "auction" ? "notary_auction" : mode === "online" ? "notary_online" : null;
  return key != null && possible.includes(key) ? key : null;
}
