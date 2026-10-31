import {
  bidBandLabels,
  bidBands,
  detailedBidBandLabels,
  detailedBidBands,
  type AdjudicationDistribution,
} from "@/lib/adjudication-distributions";
import {
  distributionRates,
  propertyTypeLabels,
  wilsonShareInterval,
  type ShareInterval,
} from "@/lib/adjudication-barometer";
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
  /** Intervalle de Wilson à 95 % de la part ; `null` sans effectif exploitable. */
  interval: ShareInterval | null;
};

/** Les deux quartiles du rapport prix adjugé publié / mise à prix : la moitié centrale des ventes. */
type PublicRatioRange = { p25: number; p75: number };

type PublicAdjudicationPropertyType = {
  propertyType: string;
  label: string;
  /** Effectif de la cellule, toujours au moins {@link PUBLIC_ADJUDICATION_MIN_SAMPLE}. */
  sampleSize: number;
  /** Médiane du rapport prix adjugé publié / mise à prix ; `null` quand le snapshot ne la porte pas. */
  medianRatio: number | null;
  /** Moitié centrale des multiples (interquartile) du type de bien. */
  ratioMiddle50: PublicRatioRange;
  aboveStartingRate: number;
  /** Intervalle de Wilson à 95 % de la part au-dessus de la mise à prix (effectif de la cellule). */
  aboveStartingInterval: ShareInterval | null;
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
  /**
   * Moitié centrale des multiples (interquartile `ratioMiddle50`) ; `null` quand le snapshot national
   * ne porte pas la distribution.
   */
  ratioMiddle50: PublicRatioRange | null;
  aboveStartingRate: number;
  /** Intervalles de Wilson à 95 % des deux parts nationales (effectif national). */
  aboveStartingInterval: ShareInterval | null;
  atLeastDoubleRate: number;
  atLeastDoubleInterval: ShareInterval | null;
  medianHammerPriceEur: number;
  medianStartingPriceEur: number;
  propertyTypes: PublicAdjudicationPropertyType[];
  bands: PublicAdjudicationPriceBand[];
  sourceLabel: string;
  warning: string;
};

function publicBands(
  distribution: AdjudicationDistribution | null | undefined,
): PublicAdjudicationPriceBand[] {
  if (!distribution) return [];
  const withInterval = (label: string, share: number) => ({
    label,
    share,
    interval: wilsonShareInterval(share, distribution.sampleSize),
  });
  const detailed = distribution.detailedBidDistribution;
  if (detailed) {
    return detailedBidBands.map((band) =>
      withInterval(
        detailedBidBandLabels[band],
        detailed.find((item) => item.band === band)?.share ?? 0,
      ),
    );
  }
  return bidBands.map((band) =>
    withInterval(
      bidBandLabels[band],
      distribution.bidDistribution.find((item) => item.band === band)?.share ?? 0,
    ),
  );
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
    .map((item) => {
      const { aboveStartingRate } = distributionRates(item.distribution);
      return {
        propertyType: item.propertyType,
        label: propertyTypeLabels[item.propertyType] ?? item.propertyType,
        sampleSize: item.distribution.sampleSize,
        medianRatio: item.distribution.summary?.medianHammerToStartingRatio ?? null,
        ratioMiddle50: {
          p25: item.distribution.ratioMiddle50.p25,
          p75: item.distribution.ratioMiddle50.p75,
        },
        aboveStartingRate,
        aboveStartingInterval: wilsonShareInterval(aboveStartingRate, item.distribution.sampleSize),
      };
    })
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
    ratioMiddle50: national.distribution
      ? {
          p25: national.distribution.ratioMiddle50.p25,
          p75: national.distribution.ratioMiddle50.p75,
        }
      : null,
    aboveStartingRate: national.metrics.aboveStartingRate,
    aboveStartingInterval: wilsonShareInterval(
      national.metrics.aboveStartingRate,
      national.sampleSize,
    ),
    atLeastDoubleRate: national.metrics.atLeastDoubleRate,
    atLeastDoubleInterval: wilsonShareInterval(
      national.metrics.atLeastDoubleRate,
      national.sampleSize,
    ),
    medianHammerPriceEur: national.metrics.medianHammerPriceEur,
    medianStartingPriceEur: national.metrics.medianStartingPriceEur,
    propertyTypes,
    bands: publicBands(national.distribution),
    sourceLabel: meta.sourceLabel,
    warning: meta.warning,
  };
}
