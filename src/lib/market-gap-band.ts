import {
  MARKET_JACKKNIFE_MIN_COMPARABLES,
  MARKET_NON_JACKKNIFE_MIN_COMPARABLES,
} from "@/lib/market-comparable-minimums";
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
 * La base ne rend qu'un mot (`public.get_public_sale_market_gap_band`, migrations 20261028200000
 * puis 20261029120000) :
 * - `under`, `near`, `above` : la mise à prix est sous, dans ou au-dessus de la fourchette des
 *   ventes comparables (P10 à P90 de l'estimation) ;
 * - `occupied` : le bien est occupé, loué, occupé par son propriétaire ou squatté, quelle que soit la
 *   bande qu'il aurait eue : la comparaison avec des ventes de biens libres n'est pas pertinente ;
 * - `occupancy_unknown` : l'occupation est inconnue, non renseignée ou illisible (56 % des ventes le
 *   20/10, 59,6 % le 23/10) : rien ne dit que le bien est libre, donc aucune bande sans réserve
 *   (migration 20261101190000). Une bande n'est dite que pour un bien libre ;
 * - `insufficient_surface`, `insufficient_type`, `insufficient` : une estimation a été tentée mais
 *   n'est pas assez fiable ; la raison est séparée (surface inconnue, type de bien non pris en
 *   charge, pas assez de ventes comparables fiables) ;
 * - rien (`null`) : aucune estimation exploitable à dire.
 *
 * La porte de qualité est celle de l'estimation du code, durcie pour l'affichage public (voir
 * l'en-tête de la migration 20261029120000) ; ce module en garde les seuils, que
 * `market-gap-band.test.ts` compare à ceux de la migration.
 */
export const MARKET_GAP_BANDS = ["under", "near", "above"] as const;
export type MarketGapBand = (typeof MARKET_GAP_BANDS)[number];

/** Les raisons pour lesquelles la fiche ne situe pas la mise à prix. */
export const MARKET_GAP_INSUFFICIENT_BANDS = [
  "insufficient_surface",
  "insufficient_type",
  "insufficient",
] as const;

/** Ce que la fiche affiche : une bande, « bien occupé », « occupation inconnue » ou la raison d'une estimation insuffisante. */
export type PublicMarketGapBand =
  | MarketGapBand
  | "occupied"
  | "occupancy_unknown"
  | (typeof MARKET_GAP_INSUFFICIENT_BANDS)[number];

const PUBLIC_MARKET_GAP_BANDS: readonly string[] = [
  ...MARKET_GAP_BANDS,
  "occupied",
  "occupancy_unknown",
  ...MARKET_GAP_INSUFFICIENT_BANDS,
];

/**
 * Porte publique, recopiée de `app_private.get_public_sale_market_gap_band` (migration
 * 20261029120000). Mesure du 20/10/2026 sur 1 547 ventes : 26 % des bandes exploitables reposaient
 * sur 4 ou 5 comparables et 8 % sur un rayon de plus d'un kilomètre.
 *
 * Nombre minimal de ventes comparables quand l'intervalle vient de la méthode jackknife locale
 * (`predictionInterval.method = "local_jackknife"`, qui suppose au moins 6 résidus dans
 * `conformalPredictionInterval` du moteur d'estimation).
 */
export const MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE = MARKET_JACKKNIFE_MIN_COMPARABLES;
/** Sans la méthode jackknife (marge fixe du type de bien, ou intervalle du modèle LightGBM). */
export const MARKET_GAP_BAND_MIN_COMPARABLES = MARKET_NON_JACKKNIFE_MIN_COMPARABLES;
/** Échantillon effectif minimal (le moteur d'estimation se contente de 3). */
export const MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE = 5;
/**
 * Largeur maximale de l'intervalle, en % de la valeur centrale : (P90 - P10) / P50. La borne de
 * 110 % de la porte de promotion d'un modèle (`evaluateValuationPromotionGate`) laissait passer des
 * fourchettes qui ne disent presque rien.
 */
export const MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT = 60;
/**
 * Rayon maximal de recherche des comparables (`estimate->>'radiusM'`). Les rayons du moteur
 * (`radiiFor`, `src/lib/market.server.ts`) vont de 150 m à 2 000 m pour un appartement urbain, de
 * 300 m à 3 000 m pour une maison urbaine, jusqu'à 5 000 m et plus en zone rurale : on exclut le
 * rayon le plus large, et `assessEngineQuality` retire déjà 8 points au-delà de 1 000 m.
 */
export const MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M = 1_000;
/** Maison, immeuble, local, terrain, appartement rural. */
export const MARKET_GAP_BAND_MAX_RADIUS_OTHER_M = 2_000;

/**
 * Rayon maximal selon le type de bien et la zone de l'estimation ; un type ou une zone inconnus
 * prennent le seuil le plus strict. Miroir de `app_private.public_market_gap_band_max_radius_m`.
 */
export function marketGapBandMaxRadiusM(
  segment: string | null | undefined,
  areaKind: string | null | undefined,
): number {
  if (
    segment === "house" ||
    segment === "building" ||
    segment === "commercial" ||
    segment === "land"
  ) {
    return MARKET_GAP_BAND_MAX_RADIUS_OTHER_M;
  }
  if (segment === "apartment" && areaKind === "rural") return MARKET_GAP_BAND_MAX_RADIUS_OTHER_M;
  return MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M;
}

/** Ce que la porte lit dans une estimation (les mêmes champs que `app_private.get_public_sale_market_gap_band`). */
export type MarketGapGateInput = {
  actionable: boolean | null | undefined;
  /** Nombre de ventes comparables retenues (`comparable_count`). */
  comparableCount: number | null | undefined;
  effectiveSampleSize: number | null | undefined;
  /** `predictionInterval.method` de l'estimation (« local_jackknife », « segment_fallback »…). */
  intervalMethod: string | null | undefined;
  /** P10, P50 et P90 dans une même unité (euros ou euros par m²) : seule leur largeur relative compte. */
  p10: number | null | undefined;
  p50: number | null | undefined;
  p90: number | null | undefined;
  radiusM: number | null | undefined;
  segment: string | null | undefined;
  areaKind: string | null | undefined;
};

/**
 * Porte publique de la bande, en TypeScript : miroir de la condition `reliable` de la fonction de la
 * migration 20261029120000, que les statistiques par tribunal appliquent à leur ratio mise à prix /
 * DVF pour que les deux affichages ne se contredisent pas. Hors de la porte : le statut « ready » de
 * l'estimation et l'activation du modèle LightGBM, que seule la base connaît.
 */
export function passesPublicMarketGapGate(input: MarketGapGateInput): boolean {
  const { p10, p50, p90, comparableCount, effectiveSampleSize, radiusM } = input;
  if (input.actionable !== true) return false;
  if (p10 == null || p50 == null || p90 == null) return false;
  if (![p10, p50, p90, comparableCount, effectiveSampleSize, radiusM].every(Number.isFinite)) {
    return false;
  }
  const minComparables =
    input.intervalMethod === "local_jackknife"
      ? MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE
      : MARKET_GAP_BAND_MIN_COMPARABLES;
  return (
    (comparableCount as number) >= minComparables &&
    (effectiveSampleSize as number) >= MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE &&
    p10 > 0 &&
    p50 > 0 &&
    p10 <= p50 &&
    p50 <= p90 &&
    (p90 - p10) / p50 <= MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT / 100 &&
    (radiusM as number) <= marketGapBandMaxRadiusM(input.segment, input.areaKind)
  );
}

/**
 * Vrai pour un bien occupé, loué, occupé par son propriétaire ou squatté. Miroir de
 * `app_private.is_occupied_occupancy_status` et de `normalizeOccupationStatus`
 * (`tribunal-listing-statistics.ts`, dont le test vérifie l'accord) : « libre » et « inconnu »
 * donnent faux.
 */
export function isOccupiedOccupancyStatus(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized || normalized === "unknown") return false;
  if (normalized === "vacant" || /inoccup|libre/.test(normalized)) return false;
  if (normalized === "rented" || normalized === "tenant_occupied" || /lou[eé]/.test(normalized)) {
    return true;
  }
  return (
    normalized === "occupied" ||
    normalized === "owner_occupied" ||
    normalized === "squatted" ||
    /occup|proprietaire|propriétaire|squat/.test(normalized)
  );
}

/**
 * Vrai pour un bien libre, vacant ou inoccupé ; faux pour un bien occupé et pour une occupation
 * inconnue. Miroir de `app_private.is_vacant_occupancy_status` (migration 20261101190000) : seul un
 * bien libre reçoit une bande d'écart au marché.
 */
export function isVacantOccupancyStatus(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized) return false;
  return normalized === "vacant" || /inoccup|libre/.test(normalized);
}

/**
 * Pourquoi l'écart avec la valeur estimée ne se dit pas pour ce bien, ou `null` pour un bien libre.
 * C'est la règle de la bande publique (`get_public_sale_market_gap_band`) : les comptes (aperçu de
 * valeur), les alertes et les filtres l'appliquent aussi, pour ne pas annoncer « environ 62 % sous la
 * valeur estimée » à propos d'un bien occupé ou dont l'occupation est inconnue, que la base ne situe pas.
 */
export function marketGapWithheldReason(
  occupancyStatus: string | null | undefined,
): "occupied" | "occupancy_unknown" | null {
  if (isOccupiedOccupancyStatus(occupancyStatus)) return "occupied";
  return isVacantOccupancyStatus(occupancyStatus) ? null : "occupancy_unknown";
}

export function isPublicMarketGapBand(value: unknown): value is PublicMarketGapBand {
  return typeof value === "string" && PUBLIC_MARKET_GAP_BANDS.includes(value);
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

/**
 * Libellé court de la bande : il décrit une position par rapport aux ventes comparables, sans dire
 * « valeur de marché », « nettement » ni « proche » (la mise à prix n'est pas un prix de marché).
 */
export const MARKET_GAP_BAND_LABELS: Record<PublicMarketGapBand, string> = {
  under: "Mise à prix inférieure à la fourchette des ventes comparables",
  near: "Mise à prix dans la fourchette des ventes comparables",
  above: "Mise à prix au-dessus de la fourchette des ventes comparables",
  occupied: "Bien occupé : la comparaison avec les ventes de biens libres n'est pas pertinente",
  occupancy_unknown:
    "Occupation du bien non précisée : la comparaison avec les ventes de biens libres ne peut pas être située",
  insufficient_surface:
    "Surface du bien inconnue : pas de comparaison possible avec les ventes du secteur",
  insufficient_type:
    "Type de bien non pris en charge par la comparaison avec les ventes du secteur",
  insufficient: "Pas assez de ventes comparables fiables pour situer cette mise à prix",
};

/** Affichée avec une bande : le prix de départ aux enchères est bas par construction. */
export const MARKET_GAP_BAND_STARTING_PRICE_NOTE =
  "Aux enchères, la mise à prix est volontairement basse : le prix final est souvent bien supérieur.";

/**
 * Précision affichée sous la bande : un prix de départ n'est pas un prix final, et rien ne prescrit.
 * La DVF est nommée avec ce qu'elle est.
 */
export const MARKET_GAP_BAND_CAUTION =
  "Repère indicatif d’après les ventes comparables du secteur, tirées de la DVF (base des ventes immobilières déclarées aux notaires). La mise à prix est un prix de départ : le prix d’adjudication peut être très différent, et des frais s’y ajoutent. Ne remplace ni une visite ni l’avis d’un professionnel.";

export const MARKET_GAP_BAND_METHOD_LABEL = "Comment est calculé ce repère ?";
export const MARKET_GAP_BAND_METHOD_PATH = MARKET_GAP_METHOD_PATH;
