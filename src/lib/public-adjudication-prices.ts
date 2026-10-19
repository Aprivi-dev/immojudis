import {
  bidBandLabels,
  bidBands,
  detailedBidBandLabels,
  detailedBidBands,
  type AdjudicationDistribution,
} from "@/lib/adjudication-distributions";
import { distributionRates, propertyTypeLabels } from "@/lib/adjudication-barometer";
import type {
  AdjudicationPriceStatisticsDirectoryResponse,
  AdjudicationPriceStatisticsScope,
} from "@/lib/adjudication-price-statistics";

/** Adresse canonique de la page publique « prix réels des adjudications ». */
export const PUBLIC_ADJUDICATION_PRICES_PATH = "/prix-encheres-immobilieres";

/**
 * Effectif minimal d'une cellule publiée (model card, « Seuils et lissage » : sous 10 résultats,
 * la cellule est entièrement masquée). Le schéma des statistiques l'impose déjà à la lecture ;
 * il est répété ici pour que la page publique ne dépende pas d'un seul garde-fou.
 */
export const PUBLIC_ADJUDICATION_MIN_SAMPLE = 10;

type FlagEnv = Readonly<Record<string, string | undefined>>;

/**
 * Interrupteur de la page publique « prix réels des adjudications », **fermé par défaut**.
 *
 * Il faut deux conditions, chacune exactement égale à la chaîne `true` (ni espaces, ni `TRUE`, ni
 * `1`) :
 * - `PUBLIC_ADJUDICATION_PRICES_ENABLED` : la décision de publier en accès libre ;
 * - `ADJUDICATION_PRICE_STATISTICS_ENABLED` : l'interrupteur d'arrêt des statistiques de prix
 *   (la page ne lit que ces agrégats). Le couper ferme aussi cette page.
 *
 * À n'ouvrir qu'avec l'accord écrit de Licitor et la relecture juridique (voir
 * docs/vercel_setup.md, « Pages publiques de prix d'adjudication »). Fermée, la page répond 404
 * et n'est pas dans le sitemap.
 */
export function isPublicAdjudicationPricesEnabled(env: FlagEnv = process.env): boolean {
  return (
    env.PUBLIC_ADJUDICATION_PRICES_ENABLED === "true" &&
    env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true"
  );
}

type PublicAdjudicationPriceBand = {
  label: string;
  /** Part des prix publiés dans la tranche (0 à 1). Jamais d'effectif brut. */
  share: number;
};

type PublicAdjudicationPropertyType = {
  propertyType: string;
  label: string;
  /** Effectif de la cellule, toujours au moins {@link PUBLIC_ADJUDICATION_MIN_SAMPLE}. */
  sampleSize: number;
  /** Médiane du rapport prix final / mise à prix ; `null` quand le snapshot ne la porte pas. */
  medianRatio: number | null;
  aboveStartingRate: number;
};

/**
 * Tout ce que la page publique affiche, et rien d'autre : des agrégats nationaux. Aucun champ ne
 * peut porter une vente, une adresse, un nom ni un tribunal (le détail par tribunal reste dans
 * l'offre Analyse) ; les tribunaux n'entrent que sous la forme d'un nombre.
 */
export type PublicAdjudicationPrices = {
  periodStart: string;
  periodEnd: string;
  builtAt: string;
  reviewedAt: string;
  sampleSize: number;
  reliability: AdjudicationPriceStatisticsScope["reliability"];
  /** Nombre de tribunaux ayant au moins {@link PUBLIC_ADJUDICATION_MIN_SAMPLE} prix publiés. */
  tribunalCount: number;
  medianRatio: number;
  aboveStartingRate: number;
  atLeastDoubleRate: number;
  medianHammerPriceEur: number;
  medianStartingPriceEur: number;
  propertyTypes: PublicAdjudicationPropertyType[];
  bands: PublicAdjudicationPriceBand[];
  sourceLabel: string;
  warning: string;
};

function publicBands(distribution: AdjudicationDistribution | null | undefined) {
  if (!distribution) return [];
  const detailed = distribution.detailedBidDistribution;
  if (detailed) {
    return detailedBidBands.map((band) => ({
      label: detailedBidBandLabels[band],
      share: detailed.find((item) => item.band === band)?.share ?? 0,
    }));
  }
  return bidBands.map((band) => ({
    label: bidBandLabels[band],
    share: distribution.bidDistribution.find((item) => item.band === band)?.share ?? 0,
  }));
}

/**
 * Réduit la réponse « annuaire » des statistiques de prix à ses seuls agrégats nationaux. Renvoie
 * `null` quand l'échantillon national est sous le seuil : la page n'affiche alors aucun chiffre.
 *
 * Le paramètre ne reprend volontairement que `national`, `meta` et le NOMBRE de tribunaux : il est
 * impossible, par construction, que le détail d'un tribunal sorte par cette fonction.
 */
export function buildPublicAdjudicationPrices(
  directory: Pick<AdjudicationPriceStatisticsDirectoryResponse, "national" | "meta"> & {
    tribunals: readonly Pick<AdjudicationPriceStatisticsScope, "sampleSize">[];
  },
): PublicAdjudicationPrices | null {
  const { national, meta } = directory;
  if (national.sampleSize < PUBLIC_ADJUDICATION_MIN_SAMPLE) return null;

  const propertyTypes = (national.propertyTypes ?? [])
    .filter((item) => item.distribution.sampleSize >= PUBLIC_ADJUDICATION_MIN_SAMPLE)
    .map((item) => ({
      propertyType: item.propertyType,
      label: propertyTypeLabels[item.propertyType] ?? item.propertyType,
      sampleSize: item.distribution.sampleSize,
      medianRatio: item.distribution.summary?.medianHammerToStartingRatio ?? null,
      aboveStartingRate: distributionRates(item.distribution).aboveStartingRate,
    }))
    .sort((a, b) => b.sampleSize - a.sampleSize || a.label.localeCompare(b.label, "fr"));

  return {
    periodStart: national.periodStart,
    periodEnd: national.periodEnd,
    builtAt: meta.builtAt,
    reviewedAt: meta.reviewedAt,
    sampleSize: national.sampleSize,
    reliability: national.reliability,
    tribunalCount: directory.tribunals.filter(
      (tribunal) => tribunal.sampleSize >= PUBLIC_ADJUDICATION_MIN_SAMPLE,
    ).length,
    medianRatio: national.metrics.medianHammerToStartingRatio,
    aboveStartingRate: national.metrics.aboveStartingRate,
    atLeastDoubleRate: national.metrics.atLeastDoubleRate,
    medianHammerPriceEur: national.metrics.medianHammerPriceEur,
    medianStartingPriceEur: national.metrics.medianStartingPriceEur,
    propertyTypes,
    bands: publicBands(national.distribution),
    sourceLabel: meta.sourceLabel,
    warning: meta.warning,
  };
}
