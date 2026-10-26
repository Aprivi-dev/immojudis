// Régime de frais d'une vente : quelles règles de frais et quel vocabulaire le calcul de l'enchère
// plafond applique, et si son calcul est ouvert pour ce type de vente. Les règles elles-mêmes sont
// dans `fee-regime-definitions.ts` (importé par le moteur) et le vocabulaire dans
// `fee-regime-labels.ts` ; ce module y ajoute le lien avec une vente (`getSaleProcedure`, conditions
// de la vente notariale) et l'interrupteur par régime. Module pur, sans import serveur.
import { TRIBUNAL_ONLY_FEE_REGIMES, type FeeRegime } from "@/lib/fee-regime-definitions";
import { NOTARY_AUCTION_FEE_REGIME, NOTARY_ONLINE_FEE_REGIME } from "@/lib/fee-regime-notary";
import {
  DEFAULT_OPEN_FEE_REGIMES,
  FEE_REGIME_KEYS,
  feeRegimeKeysForVenue,
  type FeeRegimeKey,
} from "@/lib/fee-regime-open";
import { notarySaleMode, readNotarySaleConditions } from "@/lib/notary-sale-conditions";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale, SaleLegalFramework } from "@/lib/types";

export * from "@/lib/fee-regime-definitions";
export * from "@/lib/fee-regime-labels";
export * from "@/lib/fee-regime-notary";
export * from "@/lib/fee-regime-open";

/** Les régimes définis : les autres clés de `FeeRegimeKey` (ventes domaniales) n'ont pas de règles. */
export const FEE_REGIMES: Readonly<Partial<Record<FeeRegimeKey, FeeRegime>>> = {
  ...TRIBUNAL_ONLY_FEE_REGIMES,
  notary_auction: NOTARY_AUCTION_FEE_REGIME,
  notary_online: NOTARY_ONLINE_FEE_REGIME,
};

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

/** Le régime de frais de la vente, quand son calcul est ouvert (voir `feeRegimeKeyForSale`). */
export function feeRegimeForSale(
  sale: AuctionSale,
  open: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): FeeRegime | null {
  const key = feeRegimeKeyForSale(sale, open);
  return key != null ? (FEE_REGIMES[key] ?? null) : null;
}

/**
 * Interrupteur par régime, sur le modèle de `ADJUDICATION_PRICE_STATISTICS_ENABLED` : la valeur de
 * `CEILING_FEE_REGIMES_OPEN` (clés séparées par des virgules, par exemple
 * `notary_auction,notary_online`).
 *  - Variable absente (`undefined` ou `null`) : tous les régimes définis sont ouverts.
 *  - Variable présente, même vide : seuls les régimes listés le sont ; le tribunal l'est toujours.
 *    `CEILING_FEE_REGIMES_OPEN=tribunal` ferme donc les ventes notariales.
 * Une clé inconnue est ignorée, et une clé sans règles définies n'ouvre rien (voir
 * `isFeeRegimeOpen`). Lu côté serveur (`openFeeRegimesFromEnv`) et passé en prop aux composants.
 */
export function parseOpenFeeRegimes(value: string | null | undefined): FeeRegimeKey[] {
  if (value == null) return [...DEFAULT_OPEN_FEE_REGIMES];
  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is FeeRegimeKey => (FEE_REGIME_KEYS as readonly string[]).includes(item));
  return [...new Set<FeeRegimeKey>(["tribunal", ...requested])];
}
