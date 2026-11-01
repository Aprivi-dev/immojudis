import type { AdjudicationPriceStatisticsScope } from "./adjudication-price-statistics";
import type { AdjudicationDistribution } from "./adjudication-distributions";

export const propertyTypeLabels: Record<string, string> = {
  apartment: "Appartement",
  house: "Maison",
  building: "Immeuble",
  commercial: "Local commercial",
  land: "Terrain",
  parking: "Parking",
  mixed: "Bien mixte",
};

export function distributionRates(distribution: AdjudicationDistribution) {
  const count = (band: string) =>
    distribution.bidDistribution.find((item) => item.band === band)?.count ?? 0;
  return {
    aboveStartingRate:
      (distribution.sampleSize - count("below_starting") - count("at_starting")) /
      distribution.sampleSize,
    atLeastDoubleRate: count("at_least_2") / distribution.sampleSize,
  };
}

// TODO: utiliser src/lib/stats.ts après fusion du lot 4a
/** Quantile 0,975 de la loi normale : intervalle de Wilson à 95 %. */
const WILSON_Z_95 = 1.959964;

/** Une part (0 à 1) et son intervalle de confiance de Wilson à 95 %, bornes comprises entre 0 et 1. */
export type ShareInterval = { low: number; high: number };

/**
 * Intervalle de Wilson à 95 % d'une part observée sur `total` résultats. Il reste correct pour de
 * petits effectifs et près de 0 ou de 1. `null` sans dénominateur ou pour une part hors de 0 à 1.
 */
export function wilsonShareInterval(share: number, total: number): ShareInterval | null {
  if (!Number.isFinite(share) || !Number.isFinite(total) || total <= 0) return null;
  if (share < 0 || share > 1) return null;
  const z2 = WILSON_Z_95 * WILSON_Z_95;
  const denominator = 1 + z2 / total;
  const centre = (share + z2 / (2 * total)) / denominator;
  const margin =
    (WILSON_Z_95 * Math.sqrt((share * (1 - share)) / total + z2 / (4 * total * total))) /
    denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/**
 * Tris proposés pour comparer les tribunaux. Il n'y a volontairement pas de tri par multiple médian : sur
 * 10 à 29 résultats, l'ordre des médianes est du bruit, et il serait lu comme un classement des tribunaux.
 */
export type TribunalSort = "sample" | "hammer" | "name";
export function filterAdjudicationTribunals(
  tribunals: AdjudicationPriceStatisticsScope[],
  filters: { search: string; region: string; minimumSample: number; sort: TribunalSort },
) {
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr-FR")
      .trim();
  const query = normalize(filters.search);
  return tribunals
    .filter(
      (scope) =>
        scope.sampleSize >= filters.minimumSample &&
        (!filters.region || scope.judicialRegion === filters.region) &&
        normalize(`${scope.label} ${scope.courtCode} ${scope.judicialRegion ?? ""}`).includes(
          query,
        ),
    )
    .sort((a, b) => {
      const numeric =
        filters.sort === "sample"
          ? b.sampleSize - a.sampleSize
          : filters.sort === "hammer"
            ? b.metrics.medianHammerPriceEur - a.metrics.medianHammerPriceEur
            : 0;
      return numeric || a.label.localeCompare(b.label, "fr");
    });
}

export function tribunalComparisonCsv(scopes: AdjudicationPriceStatisticsScope[]): string {
  // Spreadsheet formulas must remain plain text, even if a stored label is malformed.
  const cell = (value: string | number) => {
    const raw = String(value);
    const safe = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = [
    [
      "Tribunal",
      "Code",
      "Ressort judiciaire",
      "Début",
      "Fin",
      "Prix publiés",
      "Multiple médian",
      "Mise à prix médiane EUR",
      "Prix adjugé médian EUR",
      "Au-dessus de la mise (proportion)",
      "Au moins le double (proportion)",
      "Source",
    ],
    ...scopes.map((scope) => [
      scope.label,
      scope.courtCode ?? "",
      scope.judicialRegion ?? "",
      scope.periodStart,
      scope.periodEnd,
      scope.sampleSize,
      scope.metrics.medianHammerToStartingRatio,
      scope.metrics.medianStartingPriceEur,
      scope.metrics.medianHammerPriceEur,
      scope.metrics.aboveStartingRate,
      scope.metrics.atLeastDoubleRate,
      "Licitor — prix publiés, hors frais, non définitifs",
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
}
