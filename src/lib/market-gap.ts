import { formatPricePerM2 } from "@/lib/format/numbers";

/**
 * Écart entre la mise à prix et la valeur de marché estimée (DVF), et garde-fou d'affichage.
 *
 * Convention du code (la même que `buildValuePreview`) : `discountPct` est POSITIF quand la mise à
 * prix est SOUS la valeur estimée, négatif quand elle est au-dessus. En « prix par rapport au
 * marché » (mise à prix / valeur - 1), les seuils ci-dessous sont -70 % et +50 %.
 *
 * Seuils, et pourquoi :
 * - Décote au-delà de 70 % (mise à prix sous 30 % de la valeur estimée). La plus large des
 *   incertitudes que le moteur d'estimation admet pour une estimation de repli est de 65 %
 *   (`Math.min(0.65, …)` dans `dvf-market-statistics.ts`, soit un p10 à 35 % de la valeur) : en
 *   deçà, l'écart sort de ce que l'estimation peut distinguer d'une erreur de surface, de lot ou
 *   de type de bien.
 * - Décote inférieure à -50 % (mise à prix au-dessus de 150 % de la valeur estimée). Une mise à
 *   prix est un prix de départ : la dépasser d'une fois et demie signale une estimation fausse
 *   (surface, type, droits partiels) bien plus qu'un bien cher.
 *
 * Ces deux seuils reprennent les ordres de grandeur validés avec le propriétaire le 15/10/2026.
 * Ils n'ont pas été recalculés sur la production (pas d'accès à la base pour cette tâche) : la
 * requête de contrôle est dans le compte-rendu. Les changer ici suffit, les tests suivent les
 * constantes.
 */
export const MARKET_GAP_MAX_DISCOUNT_PCT = 70;
export const MARKET_GAP_MIN_DISCOUNT_PCT = -50;

/** Page publique qui explique le calcul de l'écart et ses limites. */
export const MARKET_GAP_METHOD_PATH = "/methode-ecart-marche";

/** Mention affichée à la place du pourcentage d'un écart aberrant. */
export const MARKET_GAP_NOT_SIGNIFICANT_LABEL = "écart non significatif";

/**
 * Phrases à la place de l'écart pour un bien occupé ou d'occupation inconnue : la valeur estimée
 * s'appuie sur des ventes de biens libres, la comparaison avec la mise à prix n'est donc pas donnée.
 */
export const MARKET_GAP_WITHHELD_OCCUPIED =
  "Bien occupé : l’écart avec la valeur estimée n’est pas indiqué, car cette valeur s’appuie sur des ventes de biens libres.";
export const MARKET_GAP_WITHHELD_OCCUPANCY_UNKNOWN =
  "Occupation du bien non précisée : l’écart avec la valeur estimée n’est pas indiqué, car cette valeur s’appuie sur des ventes de biens libres.";

/**
 * Décote en % (entier), ou `null` sans valeur ni mise à prix exploitable. Même formule que
 * partout dans le code : (valeur estimée - mise à prix) / valeur estimée.
 */
export function marketDiscountPct(
  estimatedValueEur: number | null | undefined,
  startingPriceEur: number | null | undefined,
): number | null {
  if (
    estimatedValueEur == null ||
    !Number.isFinite(estimatedValueEur) ||
    estimatedValueEur <= 0 ||
    startingPriceEur == null ||
    !Number.isFinite(startingPriceEur) ||
    startingPriceEur <= 0
  ) {
    return null;
  }
  return Math.round(((estimatedValueEur - startingPriceEur) / estimatedValueEur) * 100);
}

/** Vrai quand le pourcentage reste dans la plage où il a un sens. */
export function isSignificantMarketGap(discountPct: number): boolean {
  return (
    Number.isFinite(discountPct) &&
    discountPct <= MARKET_GAP_MAX_DISCOUNT_PCT &&
    discountPct >= MARKET_GAP_MIN_DISCOUNT_PCT
  );
}

export type MarketGap =
  | { status: "unavailable" }
  | { status: "gap"; discountPct: number }
  /** Écart aberrant : pas de pourcentage, seulement le prix au m² de la mise à prix si connu. */
  | { status: "not_significant"; startingPricePerM2: number | null };

export function resolveMarketGap(input: {
  estimatedValueEur: number | null | undefined;
  startingPriceEur: number | null | undefined;
  /** Surface de référence de l'estimation (bâtie, ou terrain pour un terrain). */
  surfaceM2?: number | null;
}): MarketGap {
  const discountPct = marketDiscountPct(input.estimatedValueEur, input.startingPriceEur);
  if (discountPct == null) return { status: "unavailable" };
  if (isSignificantMarketGap(discountPct)) return { status: "gap", discountPct };
  const surface = input.surfaceM2;
  const startingPricePerM2 =
    surface != null && Number.isFinite(surface) && surface > 0 && input.startingPriceEur
      ? Math.round(input.startingPriceEur / surface)
      : null;
  return { status: "not_significant", startingPricePerM2 };
}

/**
 * Phrase d'écart de la fiche, ou `null` sans écart. Pour un écart aberrant : la mention
 * « écart non significatif » et le prix au m² seulement, jamais le pourcentage.
 */
export function describeMarketGap(gap: {
  discountPct: number | null;
  discountNotSignificant?: boolean;
  startingPricePerM2?: number | null;
  /** Occupied property or unknown occupation: say why there is no gap (`buildValuePreview`). */
  gapWithheld?: "occupied" | "occupancy_unknown" | null;
}): string | null {
  if (gap.gapWithheld === "occupied") return MARKET_GAP_WITHHELD_OCCUPIED;
  if (gap.gapWithheld === "occupancy_unknown") return MARKET_GAP_WITHHELD_OCCUPANCY_UNKNOWN;
  if (gap.discountNotSignificant) {
    const label = `${MARKET_GAP_NOT_SIGNIFICANT_LABEL[0].toLocaleUpperCase("fr-FR")}${MARKET_GAP_NOT_SIGNIFICANT_LABEL.slice(1)}`;
    return gap.startingPricePerM2 != null
      ? `${label} : mise à prix de ${formatPricePerM2(gap.startingPricePerM2)}.`
      : `${label}.`;
  }
  if (gap.discountPct == null) return null;
  if (gap.discountPct > 0) {
    return `La mise à prix est environ ${gap.discountPct} % sous la valeur estimée du bien.`;
  }
  if (gap.discountPct < 0) {
    return `La mise à prix est environ ${-gap.discountPct} % au-dessus de la valeur estimée du bien.`;
  }
  return "La mise à prix est proche de la valeur estimée du bien.";
}
