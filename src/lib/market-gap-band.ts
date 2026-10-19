import {
  MARKET_GAP_MAX_DISCOUNT_PCT,
  MARKET_GAP_METHOD_PATH,
  MARKET_GAP_MIN_DISCOUNT_PCT,
  marketDiscountPct,
} from "@/lib/market-gap";

/**
 * Écart au marché en trois bandes, pour la fiche publique (sans compte). Aucun chiffre : ni
 * pourcentage, ni valeur, ni fourchette. Le détail reste à l'offre Analyse et au compte gratuit.
 *
 * La base ne rend qu'un mot (`public.get_public_sale_market_gap_band`, migration 20261028200000) :
 * - `under`, `near`, `above` : la mise à prix est sous, dans ou au-dessus de la fourchette de valeur
 *   estimée (P10 à P90 de l'estimation) ;
 * - `insufficient` : une estimation existe mais n'est pas assez fiable ;
 * - rien (`null`) : aucune estimation exploitable à dire.
 *
 * La porte de qualité est celle de l'estimation du code (voir l'en-tête de la migration) ; ce module
 * en garde les seuils, que `market-gap-band.test.ts` compare à ceux de la migration.
 */
export const MARKET_GAP_BANDS = ["under", "near", "above"] as const;
export type MarketGapBand = (typeof MARKET_GAP_BANDS)[number];

/** Ce que la fiche affiche : une bande, ou « estimation pas assez fiable ». */
export type PublicMarketGapBand = MarketGapBand | "insufficient";

/** Nombre minimal de ventes comparables (`MIN_ACTIONABLE_SAMPLE` du moteur d'estimation). */
export const MARKET_GAP_BAND_MIN_COMPARABLES = 4;
/** Échantillon effectif minimal (`effectiveSampleSize >= 3` du moteur d'estimation). */
export const MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE = 3;
/**
 * Largeur maximale de l'intervalle, en % de la valeur centrale : la borne de la porte de promotion
 * d'un modèle (`evaluateValuationPromotionGate`, « intervalle > 110 % »).
 */
export const MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT = 110;

export function isPublicMarketGapBand(value: unknown): value is PublicMarketGapBand {
  return value === "insufficient" || (MARKET_GAP_BANDS as readonly unknown[]).includes(value);
}

/**
 * Bande d'une mise à prix par rapport à la fourchette de valeur estimée, ou `null` sans fourchette
 * cohérente ou pour un écart aberrant (garde-fou de `market-gap.ts`, comme partout dans le code).
 * Miroir de `app_private.public_market_gap_band` : la base décide en production, ce miroir fixe
 * le comportement attendu et sert aux tests.
 */
export function marketGapBand(input: {
  startingPriceEur: number | null | undefined;
  valueLowEur: number | null | undefined;
  valueEur: number | null | undefined;
  valueHighEur: number | null | undefined;
}): MarketGapBand | null {
  const { startingPriceEur: price, valueLowEur: low, valueEur: value, valueHighEur: high } = input;
  if (price == null || low == null || value == null || high == null) return null;
  if (![price, low, value, high].every(Number.isFinite)) return null;
  if (price <= 0 || value <= 0 || low <= 0 || low > value || value > high) return null;
  const discountPct = marketDiscountPct(value, price);
  if (
    discountPct == null ||
    discountPct > MARKET_GAP_MAX_DISCOUNT_PCT ||
    discountPct < MARKET_GAP_MIN_DISCOUNT_PCT
  ) {
    return null;
  }
  if (price < low) return "under";
  if (price > high) return "above";
  return "near";
}

/** Libellé court de la bande, avec ce qu'elle compare : la mise à prix et la valeur estimée. */
export const MARKET_GAP_BAND_LABELS: Record<PublicMarketGapBand, string> = {
  under: "Mise à prix nettement sous la valeur de marché estimée",
  near: "Mise à prix proche de la valeur de marché estimée",
  above: "Mise à prix au-dessus de la valeur de marché estimée",
  insufficient: "Pas assez de ventes comparables fiables pour situer cette mise à prix",
};

/** Précision affichée sous la bande : un prix de départ n'est pas un prix final, et rien ne prescrit. */
export const MARKET_GAP_BAND_CAUTION =
  "Repère indicatif d’après les ventes comparables du secteur (DVF). La mise à prix est un prix de départ : le prix d’adjudication peut être très différent, et des frais s’y ajoutent. Ne remplace ni une visite ni l’avis d’un professionnel.";

export const MARKET_GAP_BAND_METHOD_LABEL = "Comment est calculé ce repère ?";
export const MARKET_GAP_BAND_METHOD_PATH = MARKET_GAP_METHOD_PATH;
